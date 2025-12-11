export type TokenStatus = "active" | "revoked" | "expired";

export interface MasterToken {
    id: string;
    name: string;
    access_key_id: string;
    last4?: string; // Last 4 characters of secret key
    status: TokenStatus;
    created_at: string;
    expires_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
}

export interface MasterTokenCreateInput {
    name: string;
    expires_at?: string;
}

export interface MasterTokenCreateResponse {
    id: string;
    name: string;
    access_key_id?: string;
    accessKeyId?: string; // Alternative camelCase format
    secret_access_key?: string; // Only returned once at creation
    secretAccessKey?: string; // Alternative camelCase format
    secret?: string; // Another alternative format
    status: TokenStatus;
    created_at: string;
    expires_at: string | null;
}

export interface MasterTokenRotateResponse {
    id: string;
    name: string;
    access_key_id?: string;
    accessKeyId?: string; // Alternative camelCase format
    secret_access_key?: string; // New secret key after rotation
    secretAccessKey?: string; // Alternative camelCase format
    secret?: string; // Another alternative format
    status: TokenStatus;
    created_at: string;
    expires_at: string | null;
}

export interface MasterTokenRevokeResponse {
    id: string;
    name: string;
    status: TokenStatus;
    revoked_at: string;
}

// Keep old type for backward compatibility
export interface MasterTokenCreateRequest {
    name: string;
    expires_at?: string;
}

export type ExpiryOption = "7_days" | "30_days" | "1_year" | "custom";

export const EXPIRY_OPTIONS: { value: ExpiryOption; label: string; days?: number }[] = [
    { value: "7_days", label: "7 days", days: 7 },
    { value: "30_days", label: "30 days", days: 30 },
    { value: "1_year", label: "1 year", days: 365 },
    { value: "custom", label: "Custom date" },
];

