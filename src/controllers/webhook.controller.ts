import { Request, Response } from 'express';
import { openAIService } from '../services/openai.service';
import { metaWhatsAppService } from '../services/meta.service';
import { dynamicsService } from '../services/dynamics.service';
import { sendMessage } from '../services/clickatell.service';

/**
 * Verifies the webhook for Meta WhatsApp API.
 * This is required during the initial setup in the Meta App Dashboard.
 */
export function verifyWebhook(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            console.error('Webhook verification failed: Invalid token');
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
}

/**
 * Handles incoming webhook events from Meta WhatsApp API AND Clickatell (Legacy).
 */
export async function handleIncomingMessage(req: Request, res: Response): Promise<void> {
    try {
        const body = req.body;

        // ==========================================
        // STRATEGY 1: META WHATSAPP CLOUD API
        // ==========================================
        if (body.object === 'whatsapp_business_account') {
            // Loop over entries (usually just 1)
            for (const entry of body.entry) {
                // Loop over changes (usually just 1)
                for (const change of entry.changes) {
                    const value = change.value;

                    // Check if there are messages
                    if (value.messages && value.messages.length > 0) {
                        const message = value.messages[0];

                        // We only handle text messages for now
                        if (message.type === 'text' || message.type === 'interactive') {
                            const from = message.from; // Phone number (e.g. 27832852913)

                            // Extract message body based on type
                            let messageBody = '';
                            if (message.type === 'text') {
                                messageBody = message.text.body;
                            } else if (message.type === 'interactive') {
                                const interactive = message.interactive;
                                if (interactive.type === 'button_reply') {
                                    messageBody = interactive.button_reply.title; // Or .id if prefer ID
                                } else if (interactive.type === 'list_reply') {
                                    messageBody = interactive.list_reply.title;
                                }
                            }

                            console.log(`[Meta] Received message from ${from}: ${messageBody}`);

                            // 1. Lookup Contact/Lead in Dynamics
                            const crmEntity = await dynamicsService.getContactByPhone(from);

                            // 1.5 Auto opt-in: If they're messaging us, they want to communicate
                            // 1.5 Auto opt-in: If they're messaging us, they want to communicate
                            console.log(`[OptIn Debug] Contact Found: ${crmEntity ? 'Yes' : 'No'}`);
                            if (crmEntity) {
                                console.log(`[OptIn Debug] ID: ${crmEntity.id}, Type: ${crmEntity.type}`);
                                console.log(`[OptIn Debug] Current OptIn Value:`, crmEntity.optIn);
                                console.log(`[OptIn Debug] Will Update?`, (!crmEntity.optIn));
                            }

                            if (crmEntity && crmEntity.type === 'contact' && !crmEntity.optIn) {
                                console.log(`[OptIn Debug] Triggering Update...`);
                                await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
                            }

                            // 2. Log Incoming Message to Dynamics
                            await dynamicsService.logMessage(crmEntity, messageBody, 'Incoming', from);

                            // 3. Generate AI Response
                            let history: { role: 'user' | 'assistant', content: string }[] = [];
                            if (crmEntity) {
                                history = await dynamicsService.getRecentMessages(crmEntity.id);
                                console.log(`[OpenAI] History length: ${history.length}`);
                            }

                            const responseText = await openAIService.generateResponse(messageBody, crmEntity?.id, from, history);

                            // 4. Send Reply via Meta
                            await metaWhatsAppService.sendMessage(from, responseText);

                            // 5. Log Outgoing Message to Dynamics
                            await dynamicsService.logMessage(crmEntity, responseText, 'Outgoing', from);
                        } else {
                            console.log(`[Meta] Received non-text message type: ${message.type}`);
                        }
                    }
                }
            }
            res.sendStatus(200);
            return;
        }

        // ==========================================
        // STRATEGY 2: CLICKATELL (LEGACY)
        // ==========================================
        if (body.content && body.from) {
            console.log(`[Clickatell] Received message from ${body.from}: ${body.content}`);

            const senderNumber = body.from;
            const messageContent = body.content;

            // 1. Lookup Contact/Lead in Dynamics
            const crmEntity = await dynamicsService.getContactByPhone(senderNumber);

            // 1.5 Auto opt-in: If they're messaging us, they want to communicate
            // 1.5 Auto opt-in: If they're messaging us, they want to communicate
            if (crmEntity && crmEntity.type === 'contact' && !crmEntity.optIn) {
                await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
            }

            // 2. Log Incoming Message to Dynamics
            await dynamicsService.logMessage(crmEntity, messageContent, 'Incoming', senderNumber);

            // 3. Generate AI Response
            const responseText = await openAIService.generateResponse(messageContent, crmEntity?.id, senderNumber);

            // 4. Send Reply via CLICKATELL
            await sendMessage(senderNumber, responseText);

            // 5. Log Outgoing Message to Dynamics
            await dynamicsService.logMessage(crmEntity, responseText, 'Outgoing', senderNumber);

            res.status(200).json({ success: true, message: 'Processed via Clickatell' });
            return;
        }

        // Unknown source
        console.warn('Unknown webhook payload:', JSON.stringify(body));
        res.sendStatus(404);

    } catch (error: any) {
        console.error('Error handling webhook:', error);
        res.sendStatus(500);
    }
}
