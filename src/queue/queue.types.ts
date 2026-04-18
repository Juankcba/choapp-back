export interface PushJobData {
    userId: string;
    title: string;
    body: string;
    data?: Record<string, string>;
}

export interface EmailJobData {
    to: string;
    subject: string;
    html: string;
}

export const PUSH_QUEUE = 'push';
export const EMAIL_QUEUE = 'email';
