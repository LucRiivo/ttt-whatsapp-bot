export interface CrmEntity {
    id: string;
    type: 'contact' | 'lead';
    fullname: string;
    optIn?: boolean;
}

export interface CallbackRequest {
    entityId: string;
    entityType: 'contact' | 'lead';
    phoneNumber: string;
    reason?: string;
    createdAt: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}
