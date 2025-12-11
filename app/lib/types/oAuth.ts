/**
 * OAuth Type Definitions
 * 
 * This module defines types and interfaces for OAuth authentication flows
 * supporting Google, GitHub, and Apple providers with PKCE.
 */

/**
 * Supported OAuth providers
 */
export type OAuthProvider = "google" | "github" | "apple";

/**
 * OAuth provider configuration
 */
export interface OAuthProviderConfig {
    provider: OAuthProvider;
    authUrl: string;
    clientId?: string;
    scope?: string;
    redirectUri: string;
}

/**
 * PKCE (Proof Key for Code Exchange) state
 */
export interface PKCEState {
    codeVerifier: string;
    codeChallenge: string;
    username: string;
    provider?: OAuthProvider;
}

/**
 * OAuth token response from the backend
 */
export interface OAuthTokenResponse {
    token: string;
    user: {
        id: number;
        username: string;
        email: string;
        substrate_address?: string;
    };
}

/**
 * OAuth session data stored in cookies/localStorage
 * Also used for mnemonic-based auth after verification
 */
export interface OAuthSession {
    token: string;
    userId: number;
    username: string;
    email?: string; // Optional for mnemonic auth
    substrateAddress?: string;
    provider?: OAuthProvider | "mnemonic"; // Can be OAuth provider or "mnemonic"
    expiresAt: string;
    isNew?: boolean; // From verify response
}

/**
 * OAuth error response
 */
export interface OAuthError {
    error: string;
    error_description?: string;
}

/**
 * OAuth callback query parameters
 * Backend may return either code (for exchange) or token directly
 */
export interface OAuthCallbackParams {
    code?: string;
    token?: string;
    state?: string;
    error?: string;
    error_description?: string;
    user?: {
        id?: number | string;
        username?: string;
        email?: string;
        substrate_address?: string;
    };
}
