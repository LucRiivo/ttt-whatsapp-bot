import OpenAI from 'openai';
import dotenv from 'dotenv';
import { dynamicsService } from './dynamics.service';
import { pdfService, InvoiceData } from './pdf.service';

dotenv.config();

const BASE_SYSTEM_PROMPT = `You are a helpful South African Tax Expert assistant for TTT (Tax Technicians Today).
Your role is to provide accurate, helpful advice about South African tax matters.
You also have access to the user's TTT account information (Invoices and Support Cases) via tools.

**Distinguish clearly between General Tax Questions and CRM Data Requests**:
- If the user asks 'What are the rates?' or 'Double check the brackets', answer from your GENERAL KNOWLEDGE. Do NOT check the user's specific records.
- If the user asks you to "double check" a FACT, verify your internal knowledge first. Do not default to checking CRM records unless the topic is specifically about the user's file (e.g., "Double check my invoice status").
- ONLY use the available tools if the user explicitly asks about THEIR data (e.g. "Do *I* have invoices?", "What is *my* case status?").

**Consultant Callback Requests**:
- If the user wants to speak to a consultant, talk to a human, needs personal assistance, or wants someone to call them back, use the request_consultant_callback tool.
- After submitting the request, relay the confirmation message from the tool response.

**WhatsApp Opt-Out**:
- If the user explicitly wants to stop receiving WhatsApp messages, unsubscribe, or opt out, use the opt_out_whatsapp tool.
- Confirm their opt-out was successful and let them know they can message again anytime to opt back in.

**CRM Data**:
- If the tool returns no data, inform the user politely that you couldn't find any records.
- For Invoices: Mention the invoice number, amount, and status.
- For Cases: Mention the Title (Name), Process, and Stage. **DO NOT** output the Case ID (GUID).

**Format Guidelines (CRITICAL)**:
- Responses MUST be short (under 150 words) and optimized for WhatsApp.
- **Formatting**:
  - WhatsApp uses SINGLE asterisks for bold (e.g., *bold*). **DO NOT** use double asterisks (**bold**).
  - Use _italics_ for emphasis.
  - NO Markdown headers (#). Just use *bold text* for emphasis where needed.
- Get straight to the point. Avoid fluff.
- Use max 3 bullet points if listing.
- Short sentences.
- No "Hope this helps" or generic closers.

**Tax Guidelines**:
- Always be professional and courteous
- When recommending professional help, mention that *our team at TTT* can assist (e.g., "One of our tax practitioners at TTT can help you with this" or "For personalized advice, our TTT consultants are available to assist")
- Do NOT say "consult a registered tax practitioner" - instead, promote TTT's services`;

// Tool Definitions
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "get_client_invoices",
            description: "ONLY use this when the user explicitly asks for *their* invoices, *my* bill, or payment status. Do not use for general tax questions.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_client_cases",
            description: "ONLY use this when the user explicitly asks for *their* case status, *my* application, or tickets. Do not use for general year-based queries.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_invoice_pdf",
            description: "Use this when the user asks for a COPY or PDF of a specific invoice. Requires an invoice number.",
            parameters: {
                type: "object",
                properties: {
                    invoice_number: {
                        type: "string",
                        description: "The invoice number (e.g. INV123)"
                    }
                },
                required: ["invoice_number"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "get_tax_number",
            description: "Use this when the user asks for their tax number, tax reference number, or income tax number.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "request_consultant_callback",
            description: "Use this when the client wants to speak to their consultant, talk to a human, needs personal assistance, or wants someone to call them back.",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: "Optional reason why they want to speak to a consultant"
                    }
                },
                required: [],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "opt_out_whatsapp",
            description: "Use this when the user wants to stop receiving WhatsApp messages, unsubscribe, or opt out of communications.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    }
];

export class OpenAIService {
    private openai: OpenAI | null = null;

    constructor() {
        if (process.env.OPENAI_API_KEY) {
            this.openai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
            });
        }
    }

    private getClient(): OpenAI | null {
        return this.openai;
    }

    async generateResponse(userMessage: string, contactId?: string, phoneNumber?: string, history: { role: 'user' | 'assistant', content: string }[] = []): Promise<string> {
        const client = this.getClient();

        if (!client) {
            return "🔧 **Demo Mode**: OpenAI API key missing. Cannot access CRM functions.";
        }

        try {
            const currentDate = new Date().toDateString();
            const systemPrompt = `Current Date: ${currentDate}\n${BASE_SYSTEM_PROMPT}`;

            const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
                { role: 'system', content: systemPrompt },
                ...history, // Prepend conversation history
                { role: 'user', content: userMessage },
            ];

            // 1. First Call: Natural Language or Function Call
            const completion = await client.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: messages,
                tools: contactId ? TOOLS : undefined, // Only offer tools if we know who the user is
                tool_choice: 'auto',
                max_tokens: 500,
                temperature: 0.7,
            });

            const responseMessage = completion.choices[0]?.message;

            // 2. Handle Function Calls
            if (responseMessage?.tool_calls) {
                // Append the assistant's decision to call tools to history
                messages.push(responseMessage);

                // Execute each tool call
                for (const toolCall of responseMessage.tool_calls) {
                    // Cast to any to avoid TS union type issues with CustomToolCall
                    const functionName = (toolCall as any).function.name;
                    let functionResponse = "No data found.";

                    console.log(`[OpenAI] Executing tool: ${functionName}`);

                    if (contactId) {
                        if (functionName === 'get_client_invoices') {
                            const data = await dynamicsService.getClientInvoices(contactId);
                            functionResponse = JSON.stringify(data);
                        } else if (functionName === 'get_client_cases') {
                            const data = await dynamicsService.getClientCases(contactId);
                            functionResponse = JSON.stringify(data);
                        } else if (functionName === 'get_invoice_pdf') {
                            const args = JSON.parse((toolCall as any).function.arguments);
                            const invoiceNum = args.invoice_number;

                            // Fetch invoice from Dynamics
                            const invoice = await dynamicsService.getInvoiceByNumber(invoiceNum);

                            if (!invoice) {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: `Invoice ${invoiceNum} not found.`
                                });
                            } else {
                                // Map Dynamics data to InvoiceData
                                const invoiceData: InvoiceData = {
                                    invoiceNumber: invoice.new_name,
                                    invoiceDate: new Date(invoice.createdon).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }),
                                    consultantName: invoice.riivo_consultantfullname || '',
                                    customerFullname: invoice.riivo_customerfullname || '',
                                    customerStreet: invoice.riivo_customerstreet || '',
                                    customerSuburb: invoice.riivo_customersuburb || '',
                                    customerProvince: invoice.riivo_customerprovince || '',
                                    customerCity: invoice.riivo_customercity || '',
                                    customerCountry: invoice.riivo_customercountry || '',
                                    customerPostalCode: invoice.riivo_customerponumber || '',
                                    customerVatNumber: invoice.riivo_customervatnumber || '',
                                    consultantCompany: invoice.riivo_consultantcompany || '',
                                    consultantStreet: invoice.riivo_consultantstreet || '',
                                    consultantSuburb: invoice.riivo_consultantsuburb || '',
                                    consultantProvince: invoice.riivo_consultantprovince || '',
                                    consultantCity: invoice.riivo_consultantcity || '',
                                    consultantCountry: invoice.riivo_consultantcountry || '',
                                    consultantPostalCode: invoice.riivo_consultantponumber || '',
                                    consultantVatNumber: invoice.riivo_consultantvatnumber || '',
                                    sarsReimbursement: invoice.ttt_sarsreimbursement || 0,
                                    subtotal: invoice.ttt_totalwithinterest || 0,
                                    vatAmount: invoice.riivo_vattotal || 0,
                                    totalInclVat: invoice.riivo_totalinclvat || 0,
                                    accountHolderName: invoice.icon_accountholdername || '',
                                    bankName: invoice.icon_bank || '',
                                    accountNumber: invoice.icon_accountnumber || '',
                                    accountType: invoice.icon_accounttype || '',
                                    branchNumber: invoice.icon_branchnumber || ''
                                };

                                // Return a download link - the PDF route will handle generation on-demand
                                console.log(`[PDF] Invoice ${invoiceNum} found, returning download link`);

                                functionResponse = JSON.stringify({
                                    status: "success",
                                    message: `Here's your invoice: [📄 Download ${invoiceNum}.pdf](http://localhost:3001/api/pdf/invoice/${invoiceNum})`,
                                    pdfLink: `http://localhost:3001/api/pdf/invoice/${invoiceNum}`
                                });
                            }
                        } else if (functionName === 'get_tax_number') {
                            const taxNumber = await dynamicsService.getContactTaxNumber(contactId);
                            functionResponse = taxNumber ? `Your Tax Number is: ${taxNumber}` : "I could not find a tax number on your profile.";
                        } else if (functionName === 'request_consultant_callback') {
                            const args = JSON.parse((toolCall as any).function.arguments || '{}');
                            // Get the CRM entity for this contact
                            const crmEntity = await dynamicsService.getContactByPhone(phoneNumber || contactId || '');
                            const success = await dynamicsService.createCallbackRequest(
                                crmEntity,
                                phoneNumber || contactId || 'unknown',
                                args.reason
                            );

                            if (success) {
                                // Check if within working hours (8:00-17:00 SAST, Mon-Fri)
                                const now = new Date();
                                const saTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Johannesburg' }));
                                const hour = saTime.getHours();
                                const day = saTime.getDay(); // 0 = Sunday, 6 = Saturday
                                const isWorkingHours = day >= 1 && day <= 5 && hour >= 8 && hour < 17;

                                if (isWorkingHours) {
                                    functionResponse = JSON.stringify({
                                        status: "success",
                                        message: "Your request has been submitted. A consultant will contact you within 24 hours."
                                    });
                                } else {
                                    functionResponse = JSON.stringify({
                                        status: "success",
                                        message: "Your request has been logged. A consultant will contact you on the next business day."
                                    });
                                }
                            } else {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: "I couldn't submit your request. Please try again or call our office directly."
                                });
                            }
                        } else if (functionName === 'opt_out_whatsapp') {
                            const success = await dynamicsService.updateWhatsAppOptIn(contactId, false);
                            if (success) {
                                functionResponse = JSON.stringify({
                                    status: "success",
                                    message: "You have been opted out of WhatsApp communications. If you message us again, you'll be opted back in automatically."
                                });
                            } else {
                                functionResponse = JSON.stringify({
                                    status: "error",
                                    message: "I couldn't update your preferences. Please contact our office directly."
                                });
                            }
                        }
                    } else {
                        functionResponse = "Error: User context (contactId) is missing.";
                    }

                    console.log(`[OpenAI] Tool Response:`, functionResponse);

                    // Append tool output to history
                    messages.push({
                        tool_call_id: toolCall.id,
                        role: "tool",
                        content: functionResponse,
                    });
                }

                // 3. Second Call: Generate final answer based on tool outputs
                const secondResponse = await client.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: messages,
                });

                return secondResponse.choices[0]?.message?.content || "I found the data but couldn't summarize it.";
            }

            return responseMessage?.content || 'Sorry, I could not generate a response.';

        } catch (error) {
            console.error('OpenAI API Error:', error);
            return 'I encountered an error while processing your request.';
        }
    }
}

export const openAIService = new OpenAIService();
