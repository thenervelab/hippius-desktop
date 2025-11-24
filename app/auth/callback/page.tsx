/**
 * OAuth Callback Handler Page
 * 
 * This page handles the OAuth redirect after user authenticates with
 * Google, GitHub, or Apple. It exchanges the authorization code for
 * a session token and redirects to the appropriate page.
 */

"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { oauthService } from "@/app/lib/services/oAuthService";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export default function OAuthCallbackPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const { setOAuthSession } = useWalletAuth();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const handleCallback = async () => {
            try {
                console.log("[OAuthCallback] Processing callback");

                // Get callback parameters from URL
                const code = searchParams.get("code");
                const token = searchParams.get("token");
                const error = searchParams.get("error");
                const errorDescription = searchParams.get("error_description");

                // Get user data if provided
                const userId = searchParams.get("user_id");
                const username = searchParams.get("username");
                const email = searchParams.get("email");
                const substrateAddress = searchParams.get("substrate_address");

                // Handle OAuth callback
                const session = await oauthService.handleCallback({
                    code: code || undefined,
                    token: token || undefined,
                    error: error || undefined,
                    error_description: errorDescription || undefined,
                    user: userId ? {
                        id: userId,
                        username: username || undefined,
                        email: email || undefined,
                        substrate_address: substrateAddress || undefined,
                    } : undefined,
                });

                console.log("[OAuthCallback] Session created successfully");

                // Update wallet auth context
                setOAuthSession(session);

                // Get redirect path from sessionStorage (saved during OAuth initiation)
                const redirectPath = sessionStorage.getItem("oauth_redirect") || "/";
                sessionStorage.removeItem("oauth_redirect");

                console.log("[OAuthCallback] Redirecting to:", redirectPath);

                // Redirect to original destination or dashboard
                router.replace(redirectPath);
            } catch (err) {
                console.error("[OAuthCallback] Error:", err);
                setError(
                    err instanceof Error
                        ? err.message
                        : "Authentication failed. Please try again."
                );

                // Redirect to login after 3 seconds
                setTimeout(() => {
                    router.push("/login");
                }, 3000);
            }
        };

        handleCallback();
    }, [searchParams, router, setOAuthSession]);

    if (error) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-grey-100">
                <div className="text-center space-y-4">
                    <div className="text-error-70 text-lg font-semibold">
                        Authentication Failed
                    </div>
                    <p className="text-grey-40 text-sm max-w-md">{error}</p>
                    <p className="text-grey-60 text-xs">
                        Redirecting to login page...
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center min-h-screen bg-grey-100">
            <div className="text-center space-y-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-50 mx-auto"></div>
                <p className="text-grey-40 text-sm">Completing authentication...</p>
            </div>
        </div>
    );
}
