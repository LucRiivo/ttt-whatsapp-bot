import { Router, Request, Response } from 'express';
import { openAIService } from '../services/openai.service';
import { dynamicsService } from '../services/dynamics.service';

const router = Router();

interface ChatRequest {
    message: string;
    phoneNumber?: string; // Optional phone number for testing CRM
}

interface ChatResponse {
    response: string;
}

// Direct chat endpoint for testing (bypasses Clickatell)
router.post('/chat', async (req: Request, res: Response): Promise<void> => {
    try {
        const { message, phoneNumber }: ChatRequest = req.body;
        // Default to a test number if none provided (e.g. from UI)
        const senderNumber = phoneNumber || '0832852913';

        if (!message) {
            res.status(400).json({ error: 'Message is required' });
            return;
        }

        // Dynamics CRM: Lookup & Log Incoming (optional - continue without CRM if unreachable)
        let crmEntity: any = null;
        try {
            crmEntity = await dynamicsService.getContactByPhone(senderNumber);
        } catch (dynamicsError) {
            console.warn('[Chat API] Dynamics unavailable, continuing without CRM:', (dynamicsError as Error).message);
        }

        // Auto opt-in: If they're messaging us, they want to communicate
        console.log(`[Chat OptIn Debug] Contact Found: ${crmEntity ? 'Yes' : 'No'}`);
        if (crmEntity) {
            console.log(`[Chat OptIn Debug] ID: ${crmEntity.id}, Type: ${crmEntity.type}`);
            console.log(`[Chat OptIn Debug] Current OptIn Value:`, crmEntity.optIn);
            console.log(`[Chat OptIn Debug] Will Update?`, (!crmEntity.optIn));
        }

        if (crmEntity && crmEntity.type === 'contact' && !crmEntity.optIn) {
            try {
                console.log(`[Chat OptIn Debug] Triggering Update...`);
                await dynamicsService.updateWhatsAppOptIn(crmEntity.id, true);
            } catch (e) {
                console.warn('[Chat API] Opt-in update failed:', (e as Error).message);
            }
        }

        try {
            await dynamicsService.logMessage(crmEntity, message, 'Incoming', senderNumber);
        } catch (e) {
            console.warn('[Chat API] Incoming log failed:', (e as Error).message);
        }

        console.log(`[Chat API] User: ${message}`);

        let history: { role: 'user' | 'assistant', content: string }[] = [];
        if (crmEntity) {
            try {
                history = await dynamicsService.getRecentMessages(crmEntity.id);
                console.log(`[Chat API] History length: ${history.length}`);
            } catch (e) {
                console.warn('[Chat API] History fetch failed:', (e as Error).message);
            }
        }

        let interactivePayload = undefined;
        let response = "";

        // UI TEST: Check for "testbuttons" command to simulate interactive message
        if (message.toLowerCase() === '/testbuttons') {
            response = "Here are some test buttons using the Interactive Message format:";
            interactivePayload = {
                type: 'button',
                body: { text: response },
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'btn_yes', title: 'Yes' } },
                        { type: 'reply', reply: { id: 'btn_no', title: 'No' } },
                        { type: 'reply', reply: { id: 'btn_help', title: 'Help' } }
                    ]
                }
            };
        } else {
            response = await openAIService.generateResponse(message, crmEntity?.id, senderNumber, history);
        }

        // Dynamics CRM: Log Outgoing
        try {
            await dynamicsService.logMessage(crmEntity, response, 'Outgoing', senderNumber);
        } catch (e) {
            console.warn('[Chat API] Outgoing log failed:', (e as Error).message);
        }

        console.log(`[Chat API] Bot: ${response}`);

        const chatResponse: any = { response, interactive: interactivePayload };
        res.status(200).json(chatResponse);
    } catch (error) {
        console.error('Chat API Error:', error);
        res.status(500).json({ error: 'Failed to generate response' });
    }
});

export default router;
