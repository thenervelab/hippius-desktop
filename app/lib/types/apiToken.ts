export type TokenStatus = "active" | "revoked" | "expired" | "disabled";

export type TokenPermission =
    | "read"
    | "write"
    | "read-write"
    | "admin"
    | "Object Read & Write"
    | "Object Read Only"
    | "Admin Read & Write"
    | "Admin Read Only";

export interface ApiToken {
    id: string;
    name: string;
    permission: TokenPermission;
    status: TokenStatus;
    buckets?: string[];
    applyToAll?: boolean;
    accessKeyId?: string;
    access_key_id?: string; // Alternative API field name
    secretAccessKey?: string; // Only returned once at creation or rotation
    secret?: string; // Alternative API field name for rotated tokens
    scope_type?: string; // "all_buckets" or "single_bucket"
    appliedTo?: string; // Display field for UI
    actions?: string[] | string; // "read", "write" actions from API
    expiresAt?: string; // Alternative API field name
    created_at?: string;
    expires_at?: string | null;
    createdAt?: string; // Alternative API field name
    last_used_at?: string | null;
    revoked_at?: string | null;
}

export interface CreateTokenInput {
    name: string;
    permission: TokenPermission;
    applyToAll: boolean;
    buckets?: string[];
    lifespan: "7 days" | "30 days" | "1 year" | "Forever" | "Custom";
    customDate?: Date;
}

export interface UpdateTokenInput {
    id: string;
    name?: string;
    permission?: TokenPermission;
    applyToAll?: boolean;
    buckets?: string[];
    status?: TokenStatus;
}

export interface SubTokenRotateResponse {
    id: string;
    name: string;
    access_key_id: string;
    secret: string;
    status: TokenStatus;
    created_at: string;
    expires_at: string | null;
}

export interface SubTokenRevokeResponse {
    id: string;
    name: string;
    status: TokenStatus;
    revoked_at: string;
}

// Keep old types for backward compatibility
export interface ApiTokenCreateRequest {
    name: string;
    permission: TokenPermission;
    applyToAll: boolean;
    buckets?: string[];
    lifespan: "7d" | "30d" | "90d" | "1y" | "never" | "custom";
    customDate?: Date;
}

export interface ApiTokenCreateResponse extends ApiToken {
    secretAccessKey: string; // Only returned once at creation
}

export interface ApiTokenRotateResponse {
    accessKeyId: string;
    secret: string;
}
