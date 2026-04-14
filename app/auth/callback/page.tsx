/**
 * OAuth Callback Page
 * 
 * Handles OAuth redirects from Google, GitHub, and Apple.
 * Exchanges authorization code for token and establishes persistent session.
 */

"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { useSetAtom } from "jotai";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Loader2, AlertCircle } from "lucide-react";
import type { OAuthSession } from "@/app/lib/types/oAuth";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { checkRecoveryState } from "@/app/lib/utils/recovery";

export default function OAuthCallbackPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const { setOAuthSession } = useWalletAuth();
    const setRecoveryCheck = useSetAtom(activeRecoveryCheckAtom);
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
                        const fixedUrl = currentUrl.replace(/\?/, "?FIRST?").replace(/\?/g, "&").replace(/\?FIRST\?/, "?");
                        const url = new URL(fixedUrl);
                        fixedSearchParams = url.searchParams;
                    }
                }

                const paramsToUse = fixedSearchParams || searchParams;

                const token = paramsToUse.get("token") || undefined;
                const code = paramsToUse.get("code") || undefined;
                // `state` is the CSRF token we minted in start_oauth_flow
                // and threaded through the callback URL. Forward it to
                // Rust unchanged — complete_oauth_flow rejects the
                // callback outright if it doesn't match a pending flow.
                const state = paramsToUse.get("state") || undefined;
                const error = paramsToUse.get("error") || undefined;
                const errorDescription = paramsToUse.get("error_description") || undefined;

                if (!token && !code && !error) {
                    router.replace("/login");
                    return;
                }

                const userId = paramsToUse.get("user_id") || paramsToUse.get("id");
                const username = paramsToUse.get("username");
                const email = paramsToUse.get("email");
                const substrateAddress = paramsToUse.get("substrate_address");

                // Call Rust backend to handle token exchange + DB persistence
                const result = await invoke<{
                    token: string;
                    userId: number;
                    username: string;
                    email: string;
                    substrateAddress: string;
                    provider: string;
                    expiresAt: string;
                }>("complete_oauth_flow", {
                    params: {
                        token: token || null,
                        code: code || null,
                        state: state || null,
                        error: error || null,
                        errorDescription: errorDescription || null,
                        userId: userId ? parseInt(userId, 10) : null,
                        username: username || null,
                        email: email || null,
                        substrateAddress: substrateAddress || null,
                    },
                });

                // Map Rust result to OAuthSession for the auth context
                const session: OAuthSession = {
                    token: result.token,
                    userId: result.userId,
                    username: result.username,
                    email: result.email,
                    substrateAddress: result.substrateAddress,
                    provider: result.provider as OAuthSession["provider"],
                    expiresAt: result.expiresAt,
                };

                // Store in localStorage for session restoration on boot
                localStorage.setItem("hippius_oauth_session", JSON.stringify(session));
                localStorage.setItem("hippius_oauth_session_expiry", session.expiresAt);

                // Update auth context with OAuth session. The welcome
                // notification is now created by Rust inside
                // `complete_oauth_flow` via
                // `ensure_welcome_notification`, so there is no FE-side
                // addNotification call here anymore.
                await setOAuthSession(session);

                // Populate the recovery atom BEFORE navigating so the
                // AccountRecoveryDialog renders in the same tick the
                // (pages) layout mounts. The backend also emits
                // `oauth_recovery_check_needed` during
                // `complete_oauth_flow` and the layout's
                // RecoveryEventListener picks that up — this explicit
                // check is the primary path (no race between emit and
                // subscribe), the event is belt-and-braces.
                try {
                    const recoveryCheck = await checkRecoveryState();
                    setRecoveryCheck(recoveryCheck);
                } catch (err) {
                    console.warn("[OAuthCallback] Recovery check failed:", err);
                    // Fall through — the event listener and Rust gate
                    // will still fire the dialog on the next tick.
                }

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
                            <div className="size-16 rounded-full bg-error-100 flex items-center justify-center mb-4">
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
