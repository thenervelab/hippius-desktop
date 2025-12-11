/**
 * OAuth Service
 * 
 * Handles OAuth authentication flows for Google, GitHub, and Apple.
 * Implements PKCE (Proof Key for Code Exchange) for enhanced security.
 * Manages persistent sessions using localStorage for long-term authentication.
 */

import axios from "axios";
import { API_CONFIG } from "../config";
import type {
    OAuthProvider,
    OAuthProviderConfig,
    PKCEState,
    OAuthTokenResponse,
    OAuthSession,
    OAuthCallbackParams,
} from "@/app/lib/types/oAuth";
import { openUrl } from "@tauri-apps/plugin-opener";


const OAUTH_STATE_KEY = "hippius_oauth_state";
const OAUTH_SESSION_KEY = "hippius_oauth_session";
const OAUTH_SESSION_EXPIRY_KEY = "hippius_oauth_session_expiry";

class OAuthService {
    private baseUrl: string;

    constructor() {
        // Ensure we always have a valid base URL
        this.baseUrl = API_CONFIG.baseUrl || "https://api.hippius.com";
        console.log("[OAuthService] Initialized with base URL:", this.baseUrl);
    }

    /**
     * Generate a random string for PKCE code verifier and username
     */
    private generateRandomString(length: number = 43): string {
        const charset =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
        const randomValues = new Uint8Array(length);
        crypto.getRandomValues(randomValues);
        return Array.from(randomValues)
            .map((x) => charset[x % charset.length])
            .join("");
    }

    /**
     * Generate SHA-256 hash and base64url encode for PKCE code challenge
     */
    private async generateCodeChallenge(verifier: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const hash = await crypto.subtle.digest("SHA-256", data);

        // Convert to base64url
        const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
        return base64
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=/g, "");
    }

    /**
     * Generate PKCE parameters
     */
    private async generatePKCE(): Promise<PKCEState> {
        const codeVerifier = this.generateRandomString(43);
        const codeChallenge = await this.generateCodeChallenge(codeVerifier);
        const username = this.generateRandomString(32);

        return {
            codeVerifier,
            codeChallenge,
            username,
        };
    }

    /**
     * Store PKCE state in sessionStorage
     */
    private storePKCEState(pkce: PKCEState): void {
        sessionStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(pkce));
        console.log("[OAuthService] Stored PKCE state");
    }

    /**
     * Retrieve and remove PKCE state from sessionStorage
     */
    private retrievePKCEState(): PKCEState | null {
        const stored = sessionStorage.getItem(OAUTH_STATE_KEY);
        if (!stored) {
            console.warn("[OAuthService] No PKCE state found");
            return null;
        }

        sessionStorage.removeItem(OAUTH_STATE_KEY);
        return JSON.parse(stored);
    }

    /**
     * Check if running in Tauri desktop app
     */
    private isTauri(): boolean {
        return typeof window !== 'undefined' && '__TAURI__' in window;
    }

    /**
     * Get callback URL based on environment
     */
    private getCallbackUrl(): string {
        // Always use web callback URL
        // The web page will detect if user came from desktop and redirect back
        return 'https://console.hippius.com/auth/callback';
        // return 'https://console.hippius.com/auth/callback';

    }

    /**
     * Get OAuth provider configuration
     */
    private getProviderConfig(provider: OAuthProvider): OAuthProviderConfig {
        const callbackUrl = this.getCallbackUrl();

        switch (provider) {
            case "google":
                return {
                    provider,
                    authUrl: `${this.baseUrl}/accounts/google/login/`,
                    redirectUri: callbackUrl,
                };
            case "github":
                return {
                    provider,
                    authUrl: `${this.baseUrl}/accounts/github/login/`,
                    redirectUri: callbackUrl,
                };
            case "apple":
                return {
                    provider,
                    authUrl: `${this.baseUrl}/accounts/apple/login/`,
                    redirectUri: callbackUrl,
                };
            default:
                throw new Error(`Unsupported OAuth provider: ${provider}`);
        }
    }

    /**
     * Initiate OAuth login flow
     * Redirects user to the OAuth provider's authorization page
     */
    public async initiateLogin(provider: OAuthProvider): Promise<void> {
        console.log(`[OAuthService] Initiating ${provider} login`);

        try {
            // Preserve redirect parameter if present
            const urlParams = new URLSearchParams(window.location.search);
            const redirectParam = urlParams.get("redirect");
            if (redirectParam) {
                sessionStorage.setItem("oauth_redirect", redirectParam);
                console.log("[OAuthService] Saved redirect path:", redirectParam);
            }

            // Get provider configuration
            const config = this.getProviderConfig(provider);

            // Store provider in session for callback handling
            sessionStorage.setItem("oauth_provider", provider);

            // Build authorization URL with backend's expected format:
            // /accounts/google/login/?next=/get-token/?callback_url=https://console.hippius.com/auth/callback
            const authUrl = new URL(config.authUrl);

            // Add source=desktop parameter so web callback knows to redirect back to app
            let callbackUrl = config.redirectUri;
            if (this.isTauri()) {
                callbackUrl += (callbackUrl.includes('?') ? '&' : '?') + 'source=desktop';
            }

            const nextParam = `/get-token/?callback_url=${encodeURIComponent(callbackUrl)}`;
            authUrl.searchParams.set("next", nextParam);

            const finalUrl = authUrl.toString();
            console.log("[OAuthService] OAuth URL:", finalUrl);

            // For desktop app, open in external browser
            if (this.isTauri()) {
                console.log("[OAuthService] Opening OAuth in external browser (desktop mode)");
                await openUrl(finalUrl);
            } else {
                // For web, redirect normally
                window.location.href = finalUrl;
            }
        } catch (error) {
            console.error(`[OAuthService] Failed to initiate ${provider} login:`, error);
            throw error;
        }
    }

    /**
     * Handle OAuth callback and exchange code for token
     */
    public async handleCallback(params: OAuthCallbackParams): Promise<OAuthSession> {
        console.log("[OAuthService] ========== HANDLING OAUTH CALLBACK ==========");
        console.log("[OAuthService] Full params object:", JSON.stringify(params, null, 2));

        try {
            // Check for errors
            if (params.error) {
                console.error("[OAuthService] ❌ OAuth error received:", params.error, params.error_description);
                throw new Error(
                    params.error_description || params.error || "OAuth authentication failed"
                );
            }

            console.log("[OAuthService] Callback parameters:", {
                hasToken: !!params.token,
                hasCode: !!params.code,
                hasUser: !!params.user,
                token: params.token ? `${params.token.substring(0, 10)}...` : 'none',
                code: params.code ? `${params.code.substring(0, 10)}...` : 'none',
            });

            // If we already have a token from backend (direct callback)
            if (params.token) {
                console.log("[OAuthService] Token received directly from backend");

                const provider = sessionStorage.getItem("oauth_provider") as OAuthProvider || "google";
                sessionStorage.removeItem("oauth_provider");

                // Create session directly with the token
                const session: OAuthSession = {
                    token: params.token,
                    userId: params.user?.id ? (typeof params.user.id === 'number' ? params.user.id : parseInt(params.user.id, 10)) : 0,
                    username: params.user?.username || "",
                    email: params.user?.email || "",
                    substrateAddress: params.user?.substrate_address || "",
                    provider: provider,
                    expiresAt: this.getSessionExpiry(),
                };

                // Store session (persistent)
                this.storeSession(session);

                console.log("[OAuthService] OAuth login successful");
                return session;
            }

            // Fallback: handle code-based flow (if backend returns code instead of token)
            if (params.code) {
                const provider = sessionStorage.getItem("oauth_provider") as OAuthProvider || "google";
                sessionStorage.removeItem("oauth_provider");

                console.log("[OAuthService] Provider:", provider);

                // Exchange authorization code for token
                const tokenResponse = await this.exchangeCodeForToken(
                    params.code,
                    provider
                );

                // Create session with substrate_address
                const session: OAuthSession = {
                    token: tokenResponse.token,
                    userId: tokenResponse.user.id,
                    username: tokenResponse.user.username,
                    email: tokenResponse.user.email,
                    substrateAddress: tokenResponse.user.substrate_address,
                    provider: provider,
                    expiresAt: this.getSessionExpiry(),
                };

                // Store session (persistent)
                this.storeSession(session);

                console.log("[OAuthService] OAuth login successful");
                return session;
            }

            throw new Error("Missing both token and authorization code");
        } catch (error) {
            console.error("[OAuthService] Callback handling failed:", error);
            throw error;
        }
    }

    /**
     * Exchange authorization code for access token
     */
    private async exchangeCodeForToken(
        code: string,
        provider: OAuthProvider
    ): Promise<OAuthTokenResponse> {
        console.log("[OAuthService] Exchanging code for token");

        try {
            const response = await axios.post(`${this.baseUrl}/api/auth/exchange/`, {
                code,
                code_verifier: provider,
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            });

            const data: OAuthTokenResponse = response.data;
            console.log("[OAuthService] Token exchange successful");
            return data;
        } catch (error) {
            console.error("[OAuthService] Token exchange failed:", error);
            throw new Error(`Token exchange failed: ${error}`);
        }
    }

    /**
     * Get session expiry (30 days from now)
     */
    private getSessionExpiry(): string {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 30);
        return expiry.toISOString();
    }

    /**
     * Store OAuth session (persistent)
     */
    private storeSession(session: OAuthSession): void {
        console.log("[OAuthService] Storing OAuth session");
        localStorage.setItem(OAUTH_SESSION_KEY, JSON.stringify(session));
        localStorage.setItem(OAUTH_SESSION_EXPIRY_KEY, session.expiresAt);
    }

    /**
     * Retrieve OAuth session from unified storage
     * Works for both OAuth and mnemonic sessions
     */
    public getSession(): OAuthSession | null {
        try {
            const sessionData = localStorage.getItem(OAUTH_SESSION_KEY);
            const expiry = localStorage.getItem(OAUTH_SESSION_EXPIRY_KEY);

            if (!sessionData || !expiry) {
                return null;
            }

            // Check if session is expired
            if (new Date(expiry) < new Date()) {
                console.warn("[OAuthService] Session expired");
                this.clearSession();
                return null;
            }

            const session = JSON.parse(sessionData);

            // Only return OAuth sessions (not mnemonic)
            if (session.provider === "mnemonic") {
                return null;
            }

            return session;
        } catch (error) {
            console.error("[OAuthService] Failed to retrieve session:", error);
            return null;
        }
    }

    /**
     * Check if user is authenticated via OAuth
     */
    public isAuthenticated(): boolean {
        return this.getSession() !== null;
    }

    /**
     * Get OAuth token
     */
    public getToken(): string | null {
        const session = this.getSession();
        return session?.token || null;
    }

    /**
     * Clear OAuth session
     */
    public clearSession(): void {
        console.log("[OAuthService] Clearing OAuth session");
        localStorage.removeItem(OAUTH_SESSION_KEY);
        localStorage.removeItem(OAUTH_SESSION_EXPIRY_KEY);
    }

    /**
     * Logout (clear session and redirect)
     */
    public logout(): void {
        console.log("[OAuthService] Logging out");
        this.clearSession();
    }
}

export const oauthService = new OAuthService();
