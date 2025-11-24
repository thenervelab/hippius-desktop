/**
 * OAuth Deep Link Hook for Tauri
 * 
 * Listens for OAuth callback deep links from Tauri desktop app
 * and processes them through the OAuth service.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { oauthService } from "@/app/lib/services/oAuthService";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export function useOAuthDeepLink() {
    const router = useRouter();
    const { setOAuthSession } = useWalletAuth();

    useEffect(() => {
        // Only run in Tauri environment
        if (typeof window === 'undefined' || !('__TAURI__' in window)) {
            return;
        }

        let unlisten: (() => void) | null = null;

        async function setupListener() {
            try {
                const { listen } = await import("@tauri-apps/api/event");

                // Listen for OAuth callback events from Rust
                unlisten = await listen<string>("oauth-callback", async (event) => {
                    console.log("[useOAuthDeepLink] Received deep link:", event.payload);

                    try {
                        // Parse the deep link URL
                        const url = new URL(event.payload);

                        // Extract query parameters
                        const params = {
                            code: url.searchParams.get("code") || undefined,
                            token: url.searchParams.get("token") || undefined,
                            state: url.searchParams.get("state") || undefined,
                            error: url.searchParams.get("error") || undefined,
                            error_description: url.searchParams.get("error_description") || undefined,
                            user: url.searchParams.get("user_id") ? {
                                id: url.searchParams.get("user_id") || undefined,
                                username: url.searchParams.get("username") || undefined,
                                email: url.searchParams.get("email") || undefined,
                                substrate_address: url.searchParams.get("substrate_address") || undefined,
                            } : undefined,
                        };

                        console.log("[useOAuthDeepLink] Parsed params:", params);

                        // Handle the OAuth callback
                        const session = await oauthService.handleCallback(params);

                        // Set session in wallet context
                        setOAuthSession(session);

                        // Check for redirect parameter
                        const redirectPath = sessionStorage.getItem("oauth_redirect") || "/";
                        sessionStorage.removeItem("oauth_redirect");

                        console.log("[useOAuthDeepLink] Redirecting to:", redirectPath);
                        router.push(redirectPath);
                    } catch (error) {
                        console.error("[useOAuthDeepLink] Failed to handle callback:", error);
                        router.push("/login?error=oauth_failed");
                    }
                });

                console.log("[useOAuthDeepLink] Deep link listener registered");
            } catch (error) {
                console.error("[useOAuthDeepLink] Failed to setup listener:", error);
            }
        }

        setupListener();

        // Cleanup
        return () => {
            if (unlisten) {
                unlisten();
                console.log("[useOAuthDeepLink] Deep link listener cleaned up");
            }
        };
    }, [router, setOAuthSession]);
}
