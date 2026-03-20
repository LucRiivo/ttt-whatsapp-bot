import axios from 'axios';
import * as msal from '@azure/msal-node';
import dotenv from 'dotenv';
import { CrmEntity } from '../types/crm.types';

dotenv.config();

// Define CrmEntity locally if not imported, or ensure import is correct.
// Based on previous file content, it was defined locally.
export interface LocalCrmEntity {
    id: string;
    type: 'contact' | 'lead';
    fullname: string;
}

export class DynamicsService {
    private cca: msal.ConfidentialClientApplication;
    private baseUrl: string;
    private accessToken: string | null = null;
    private tokenExpiry: number = 0;

    constructor() {
        if (!process.env.DYNAMICS_CLIENT_ID || !process.env.DYNAMICS_CLIENT_SECRET || !process.env.DYNAMICS_TENANT_ID || !process.env.DYNAMICS_URL) {
            throw new Error('Missing Dynamics CRM configuration in .env');
        }

        const config = {
            auth: {
                clientId: process.env.DYNAMICS_CLIENT_ID,
                clientSecret: process.env.DYNAMICS_CLIENT_SECRET,
                authority: `https://login.microsoftonline.com/${process.env.DYNAMICS_TENANT_ID}`,
            }
        };

        this.cca = new msal.ConfidentialClientApplication(config);
        this.baseUrl = process.env.DYNAMICS_URL.replace(/\/$/, ''); // Remove trailing slash
    }

    private async getToken(): Promise<string> {
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }

        try {
            const clientCredentialRequest = {
                scopes: [`${this.baseUrl}/.default`],
            };

            const response = await this.cca.acquireTokenByClientCredential(clientCredentialRequest);

            if (!response || !response.accessToken) {
                throw new Error('Failed to acquire access token');
            }

            this.accessToken = response.accessToken;
            this.tokenExpiry = response.expiresOn ? response.expiresOn.getTime() : Date.now() + 55 * 60 * 1000;

            return this.accessToken;
        } catch (error) {
            console.error('Dynamics Auth Error:', error);
            throw error;
        }
    }

    private async searchEntity(collection: string, filter: string, select: string[]): Promise<any | null> {
        const token = await this.getToken();

        try {
            const url = `${this.baseUrl}/api/data/v9.2/${collection}?$filter=${encodeURIComponent(filter)}&$select=${select.join(',')}&$top=1`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json'
                }
            });

            if (response.data && response.data.value && response.data.value.length > 0) {
                return response.data.value[0];
            }

            return null;
        } catch (error) {
            console.error(`Error searching ${collection}:`, error);
            return null;
        }
    }

    private async getList(collection: string, filter: string, select: string[]): Promise<any[]> {
        const token = await this.getToken();

        try {
            const url = `${this.baseUrl}/api/data/v9.2/${collection}?$filter=${encodeURIComponent(filter)}&$select=${select.join(',')}&$orderby=createdon desc&$top=5`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json',
                    'Prefer': 'odata.include-annotations="*"'
                }
            });

            return response.data.value || [];
        } catch (error: any) {
            console.error(`Error getting list from ${collection}:`, error?.response?.data || error.message);
            return [];
        }
    }

    async getClientInvoices(contactId: string): Promise<any[]> {
        return this.getList(
            'new_invoiceses',
            `_ttt_customer_value eq ${contactId}`,
            ['new_invoicesid', 'new_name', 'riivo_totalinclvat', 'statecode', 'statuscode']
        );
    }

    async getInvoiceByNumber(invoiceNumber: string): Promise<any | null> {
        const token = await this.getToken();
        const selectFields = [
            // Invoice header
            'new_name', 'createdon',
            // Customer details
            'riivo_customerfullname', 'riivo_customerstreet', 'riivo_customerprovince',
            'riivo_customersuburb', 'riivo_customerponumber', 'riivo_customercity',
            'riivo_customercountry', 'riivo_customervatnumber',
            // Consultant details
            'riivo_consultantcompany', 'riivo_consultantfullname', 'riivo_consultantstreet',
            'riivo_consultantsuburb', 'riivo_consultantprovince', 'riivo_consultantponumber',
            'riivo_consultantcity', 'riivo_consultantcountry', 'riivo_consultantvatnumber',
            // Totals
            'ttt_sarsreimbursement', 'ttt_totalwithinterest', 'riivo_vattotal', 'riivo_totalinclvat',
            // Banking
            'icon_accountholdername', 'icon_bank', 'icon_accountnumber',
            'icon_accounttype', 'icon_branchnumber'
        ];

        try {
            // Use contains since invoice names are like "Jules Test - INV522385182"
            const url = `${this.baseUrl}/api/data/v9.2/new_invoiceses?$filter=${encodeURIComponent(`contains(new_name,'${invoiceNumber}')`)}&$select=${selectFields.join(',')}&$top=1`;

            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'OData-MaxVersion': '4.0',
                    'OData-Version': '4.0',
                    'Accept': 'application/json'
                }
            });

            if (response.data?.value?.length > 0) {
                return response.data.value[0];
            }
            return null;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to get invoice:', error?.response?.data?.error?.message || error.message);
            return null;
        }
    }

    async getClientCases(contactId: string): Promise<any[]> {
        return this.getList(
            'new_cases',
            `_ttt_clientname_value eq ${contactId}`,
            ['new_name', 'icon_caseprocess', 'icon_casestage', 'statecode', 'createdon']
        );
    }

    async getContactByPhone(phoneNumber: string): Promise<any | null> {
        // Search Contacts
        const contact = await this.searchEntity(
            'contacts',
            `mobilephone eq '${phoneNumber}' and statecode eq 0`,
            ['contactid', 'fullname', 'riivo_whatsappoptinout']
        );

        if (contact) {
            return {
                id: contact.contactid,
                type: 'contact',
                fullname: contact.fullname,
                optIn: contact.riivo_whatsappoptinout
            };
        }

        // Search Leads
        const lead = await this.searchEntity(
            'leads',
            `ttt_mobilephone eq '${phoneNumber}' and statecode eq 0`,
            ['leadid', 'fullname']
        );

        if (lead) {
            return {
                id: lead.leadid,
                type: 'lead',
                fullname: lead.fullname
            };
        }

        if (lead) {
            return {
                id: lead.leadid,
                type: 'lead',
                fullname: lead.fullname
            };
        }

        return null;
    }

    async getContactTaxNumber(contactId: string): Promise<string | null> {
        const contact = await this.searchEntity(
            'contacts',
            `contactid eq ${contactId}`,
            ['ttt_taxnumber']
        );
        return contact ? contact.ttt_taxnumber : null;
    }

    async logMessage(
        entity: any | null,
        messageContent: string,
        direction: 'Incoming' | 'Outgoing',
        phoneNumber: string
    ): Promise<void> {
        const token = await this.getToken();
        const directionValue = direction === 'Incoming' ? 463630000 : 463630001;

        const payload: any = {
            "subject": `WhatsApp ${direction}: ${phoneNumber}`,
            "description": messageContent,
            "riivo_messagedirection": directionValue,
            "riivo_from": direction === 'Incoming' ? phoneNumber : 'Bot',
            "riivo_to": direction === 'Incoming' ? 'Bot' : phoneNumber,
            "riivo_timestamp": new Date().toISOString()
        };

        if (entity) {
            if (entity.type === 'contact') {
                payload['regardingobjectid_contact@odata.bind'] = `/contacts(${entity.id})`;
            } else {
                payload['regardingobjectid_lead@odata.bind'] = `/leads(${entity.id})`;
            }
        }

        try {
            await axios.post(
                `${this.baseUrl}/api/data/v9.2/riivo_whatsappcommunicationses`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation'
                    }
                }
            );
            console.log(`[Dynamics CRM] Logged ${direction} message for ${phoneNumber}`);
        } catch (error: any) {
            console.error('[Dynamics CRM] Logging failed:', error?.response?.data?.error?.message || error.message);
        }
    }

    async uploadDocument(
        entity: any | null,
        fileName: string,
        mimeType: string,
        fileBuffer: Buffer
    ): Promise<void> {
        if (!entity) {
            console.warn('[Dynamics CRM] Cannot upload document: No linked entity found.');
            return;
        }

        const token = await this.getToken();
        const base64Content = fileBuffer.toString('base64');

        const payload: any = {
            "subject": `WhatsApp Document: ${fileName}`,
            "filename": fileName,
            "mimetype": mimeType,
            "documentbody": base64Content,
            "notetext": "Document received via WhatsApp Bot."
        };

        // Link to regarding object
        if (entity.type === 'contact') {
            payload['objectid_contact@odata.bind'] = `/contacts(${entity.id})`;
            payload['objecttypecode'] = 'contact';
        } else {
            payload['objectid_lead@odata.bind'] = `/leads(${entity.id})`;
            payload['objecttypecode'] = 'lead';
        }

        try {
            await axios.post(
                `${this.baseUrl}/api/data/v9.2/annotations`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log(`[Dynamics CRM] Uploaded document ${fileName} to ${entity.type} ${entity.id}`);
        } catch (error: any) {
            console.error('[Dynamics CRM] Document upload failed:', error?.response?.data?.error?.message || error.message);
        }
    }

    /**
     * Create a callback request in Dynamics CRM (riivo_requests entity).
     * Power Automate will handle consultant assignment and notifications.
     */
    async createCallbackRequest(
        entity: { id: string; type: 'contact' | 'lead'; fullname: string } | null,
        phoneNumber: string,
        reason?: string
    ): Promise<boolean> {
        const token = await this.getToken();

        const payload: any = {
            "riivo_clientmobilenumber": phoneNumber,
            "riivo_channel": 1, // WhatsApp channel
            "riivo_description": reason || "Client requested to speak with a consultant via WhatsApp.",
            "riivo_category": 0, // Default category
            "riivo_priority": 1  // Default priority
        };

        // Link to contact or lead using lookup value directly
        if (entity) {
            if (entity.type === 'contact') {
                payload['riivo_Client@odata.bind'] = `/contacts(${entity.id})`;
            } else {
                payload['riivo_Lead@odata.bind'] = `/leads(${entity.id})`;
            }
        }

        try {
            await axios.post(
                `${this.baseUrl}/api/data/v9.2/riivo_requests`,
                payload,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Prefer': 'return=representation'
                    }
                }
            );
            console.log(`[Dynamics CRM] Created callback request for ${phoneNumber}`);
            return true;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to create callback request:', error?.response?.data?.error?.message || error.message);
            return false;
        }
    }

    /**
     * Update WhatsApp opt-in/out status for a contact.
     * @param contactId - The contact GUID
     * @param optIn - true to opt in, false to opt out
     */
    async updateWhatsAppOptIn(contactId: string, optIn: boolean): Promise<boolean> {
        const token = await this.getToken();

        try {
            await axios.patch(
                `${this.baseUrl}/api/data/v9.2/contacts(${contactId})`,
                {
                    "riivo_whatsappoptinout": optIn
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'OData-MaxVersion': '4.0',
                        'OData-Version': '4.0',
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                }
            );
            console.log(`[Dynamics CRM] Updated WhatsApp opt-in for contact ${contactId}: ${optIn}`);
            return true;
        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to update WhatsApp opt-in:', error?.response?.data?.error?.message || error.message);
            return false;
        }
    }

    async getRecentMessages(contactId: string, limit: number = 10): Promise<{ role: 'user' | 'assistant', content: string }[]> {
        const token = await this.getToken();

        // Filter for last 24 hours
        const yesterday = new Date();
        yesterday.setHours(yesterday.getHours() - 24);
        const dateFilter = yesterday.toISOString();

        try {
            // Determine if contactId is contact or lead (we might need to check both or assume contact for now based on usage)
            // Ideally we'd filter by _regardingobjectid_value but OData makes that tricky with polymorphism.
            // Simplified approach: Filter by contact link if we know it's a contact.

            // NOTE: The previous logMessage uses 'regardingobjectid_contact' bind. 
            // So we look for _regardingobjectid_value matching contactId.
            // Use standard OData filter for createdon > 24h ago.

            const filter = `_regardingobjectid_value eq ${contactId} and createdon gt ${dateFilter}`;

            const messages = await this.getList(
                'riivo_whatsappcommunicationses',
                filter,
                ['description', 'riivo_messagedirection', 'createdon']
            );

            // Map to ChatMessage format
            // riivo_messagedirection: 463630000 = Incoming (User), 463630001 = Outgoing (Bot)
            return messages.map(msg => ({
                role: (msg.riivo_messagedirection === 463630000 ? 'user' : 'assistant') as 'user' | 'assistant',
                content: msg.description || ''
            })).reverse(); // Reverse to have oldest first for OpenAI context

        } catch (error: any) {
            console.error('[Dynamics CRM] Failed to fetch recent messages:', error?.response?.data?.error?.message || error.message);
            return [];
        }
    }
}

export const dynamicsService = new DynamicsService();
