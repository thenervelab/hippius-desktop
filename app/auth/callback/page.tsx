/**
 * OAuth Callback Page
 * 
 * Handles OAuth redirects from Google, GitHub, and Apple.
 * Exchanges authorization code for token and establishes persistent session.
 */

"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { oauthService } from "@/app/lib/services/oAuthService";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Loader2, AlertCircle } from "lucide-react";
import type { OAuthCallbackParams } from "@/app/lib/types/oAuth";
import {
    addNotification,
} from "@/app/lib/helpers/notificationsDb";

export default function OAuthCallbackPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { setOAuthSession } = useWalletAuth();
    const [error, setError] = useState<string | null>(null);
    const hasProcessed = useRef(false);

    useEffect(() => {
        // Prevent multiple executions
        if (hasProcessed.current) {
            return;
        }

        const handleCallback = async () => {
            try {
                hasProcessed.current = true;
                // FIRST: Check if user is already authenticated via localStorage
                // This check happens before processing any parameters to handle app restarts
                const storedSession = localStorage.getItem("hippius_oauth_session");
                const storedExpiry = localStorage.getItem("hippius_oauth_session_expiry");

                if (storedSession && storedExpiry) {
                    const expiryTime = isNaN(Number(storedExpiry))
                        ? new Date(storedExpiry).getTime()
                        : parseInt(storedExpiry, 10);

                    if (Date.now() < expiryTime) {
                        router.replace("/");
                        return;
                    } else {
                        localStorage.removeItem("hippius_oauth_session");
                        localStorage.removeItem("hippius_oauth_session_expiry");
                    }
                }

                // Fix malformed URL with multiple question marks (backend issue workaround)
                // Example: ?source=desktop?code=xxx should be ?source=desktop&code=xxx
                let fixedSearchParams: URLSearchParams | null = null;
                if (typeof window !== "undefined") {
                    const currentUrl = window.location.href;
                    const questionMarkCount = (currentUrl.match(/\?/g) || []).length;

                    if (questionMarkCount > 1) {
                        // Replace all ? after the first one with &
                        const fixedUrl = currentUrl.replace(/\?/, "?FIRST?").replace(/\?/g, "&").replace(/\?FIRST\?/, "?");

                        // Parse the fixed URL
                        const url = new URL(fixedUrl);
                        fixedSearchParams = url.searchParams;
                    }
                }

                // Use fixed params if available, otherwise use original
                const paramsToUse = fixedSearchParams || searchParams;

                // Extract callback parameters
                const params: OAuthCallbackParams = {
                    code: paramsToUse.get("code") || undefined,
                    token: paramsToUse.get("token") || undefined,
                    error: paramsToUse.get("error") || undefined,
                    error_description: paramsToUse.get("error_description") || undefined,
                };

                // If no token and no code, user landed here without valid OAuth params
                // Since we already checked for valid session at the start, redirect to login
                if (!params.token && !params.code && !params.error) {
                    router.replace("/login");
                    return;
                }

                // Extract user data if provided (also check 'id' as fallback for 'user_id')
                const userId = paramsToUse.get("user_id") || paramsToUse.get("id");
                const username = paramsToUse.get("username");
                const email = paramsToUse.get("email");
                const substrateAddress = paramsToUse.get("substrate_address");

                if (userId || username) {
                    params.user = {
                        id: userId || undefined,
                        username: username || undefined,
                        email: email || undefined,
                        substrate_address: substrateAddress || undefined,
                    };
                }

                // Handle OAuth callback
                const session = await oauthService.handleCallback(params);


                // Update auth context with OAuth session
                await setOAuthSession(session);

                // Add welcome notification for this user (built-in duplicate check)
                await addNotification({
                    userAddress: session.substrateAddress!,
                    notificationType: "Hippius",
                    notificationSubtype: "Welcome",
                    notificationTitleText: "Hello from Hippius 👋  Here's what's new!",
                    notificationDescription: `🎉 Welcome to Hippius! You're now part of a decentralised storage network. To get started, open the Files tab and upload your data. Each upload uses credits from your balance. We keep credit pricing simple and fair, so you always know what you're spending. You can check your remaining credits at any time in the billing tab, and top up when you need more. When you're ready, tap Check Out to launch your first storage session.`,
                    notificationLinkText: "Check Out",
                    notificationLink: "/files",
                });

                // Get redirect path from URL params, sessionStorage, or default
                const urlRedirect = searchParams.get("redirect");
                const storedRedirect = sessionStorage.getItem("oauth_redirect");
                const redirectPath = urlRedirect || storedRedirect || "/";

                // Clean up - remove all OAuth-related session storage
                sessionStorage.removeItem("oauth_redirect");

                // Use replace to avoid back button issues
                router.replace(redirectPath);
            } catch (err) {
                console.error("[OAuthCallback] Failed to process callback:", err);
                setError(
                    err instanceof Error
                        ? err.message
                        : "Failed to complete authentication. Please try again."
                );
            }
        };

        handleCallback();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (error) {
        return (
            <div className="fixed inset-0 w-screen h-screen flex items-center justify-center bg-white z-50">
                <div className="w-full max-w-md mx-auto px-4">
                    <div className="bg-white rounded-xl shadow-lg p-8 border border-grey-90">
                        <div className="flex flex-col items-center text-center">
                            <div className="size-16 rounded-full bg-error-95 flex items-center justify-center mb-4">
                                <AlertCircle className="size-8 text-error-50" />
                            </div>
                            <h1 className="text-2xl font-semibold text-grey-10 mb-2">
                                Authentication Failed
                            </h1>
                            <p className="text-grey-60 mb-6">
                                {error}
                            </p>
                            <button
                                onClick={() => {
                                    // Mark as manual navigation to prevent deep link re-processing
                                    sessionStorage.setItem("manual_navigation", "true");
                                    router.replace("/login");
                                }}
                                className="px-6 py-3 bg-primary-50 text-white rounded-lg font-medium hover:bg-primary-60 transition-colors"
                            >
                                Back to Login
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 w-screen h-screen flex items-center justify-center bg-white z-50">
            <div className="w-full max-w-md mx-auto px-4">
                <div className="bg-white rounded-xl shadow-lg p-8 border border-grey-90">
                    <div className="flex flex-col items-center text-center">
                        <div className="size-16 rounded-full bg-primary-95 flex items-center justify-center mb-4">
                            <Loader2 className="size-8 text-primary-50 animate-spin" />
                        </div>
                        <h1 className="text-2xl font-semibold text-grey-10 mb-2">
                            Completing Sign In
                        </h1>
                        <p className="text-grey-60">
                            Please wait while we securely authenticate your account...
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
