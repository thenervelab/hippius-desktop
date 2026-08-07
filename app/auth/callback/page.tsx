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
import {
    OAUTH_SESSION_EXPIRY_KEY,
    OAUTH_SESSION_KEY,
    clearOAuthSessionHint,
    persistOAuthSessionHint,
} from "@/app/lib/auth/oauthSessionHint";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { checkRecoveryState } from "@/app/lib/utils/recovery";
import { Button } from "@/components/ui/button";
import { BackgroundContainer } from "@/components/ui/BackgroundContainer";
import { LogoMark } from "@/components/ui/LogoMark";
import AppVersion from "@/components/ui/AppVersion";
import { openUrl } from "@tauri-apps/plugin-opener";

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
                const storedSession = localStorage.getItem(OAUTH_SESSION_KEY);
                const storedExpiry = localStorage.getItem(OAUTH_SESSION_EXPIRY_KEY);

                if (storedSession && storedExpiry) {
                    const expiryTime = isNaN(Number(storedExpiry))
                        ? new Date(storedExpiry).getTime()
                        : parseInt(storedExpiry, 10);

                    if (Date.now() < expiryTime) {
                        router.replace("/");
                        return;
                    } else {
                        clearOAuthSessionHint();
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
                persistOAuthSessionHint(session);

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

    // The callback is reached straight from the login screen, so it reuses
    // that screen's branded frame (BackgroundContainer) and footer
    // (Terms/Privacy + version, matching `LoginForm`) instead of a bare white
    // page — otherwise the flash between login → callback reads as a jarring
    // unstyled screen, and in dark mode the old `bg-white` blinded the user.
    const heading = error ? "Authentication Failed" : "Completing Sign In";
    const description =
        error ?? "Please wait while we securely authenticate your account...";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-white dark:bg-[#0a0a0a]">
            <BackgroundContainer
                addDotWithBlurryEffect
                hippoIconClassName="fill-[#989898] dark:fill-[#5e5e5e]"
                cardClassName="w-full max-w-[461px] items-center gap-4 p-6 text-center"
            >
                <LogoMark />

                <h1 className="w-full text-center font-medium text-[28px] leading-9 tracking-[-0.03em] text-grey-10 dark:text-grey-light-100">
                    {heading}
                </h1>

                {error ? (
                    <div className="flex size-12 items-center justify-center rounded-full bg-error-100 dark:bg-error-50/15">
                        <AlertCircle className="size-6 text-error-50" />
                    </div>
                ) : (
                    <Loader2 className="size-6 animate-spin text-primary-50 dark:text-primary-65" />
                )}

                <p className="w-full text-center text-[14px] font-medium leading-5 text-grey-60 dark:text-grey-dark-600">
                    {description}
                </p>

                {error ? (
                    <Button
                        variant="primary"
                        className="h-12 w-full"
                        onClick={() => {
                            // Mark as manual navigation to prevent deep link re-processing
                            sessionStorage.setItem("manual_navigation", "true");
                            router.replace("/login");
                        }}
                    >
                        Back to Login
                    </Button>
                ) : null}

                <div className="h-px w-full bg-grey-80 dark:bg-[#494949]" />

                <p className="w-full text-center text-[12px] font-medium leading-[18px] tracking-[-0.02em] text-grey-dark-800">
                    By continuing you agree to our
                    <br />
                    <button
                        type="button"
                        onClick={() => openUrl("https://hippius.com/terms-and-conditions")}
                        className="cursor-pointer font-semibold text-primary-50 transition-colors hover:text-primary-60 dark:text-primary-65"
                    >
                        Terms and Conditions
                    </button>{" "}
                    and{" "}
                    <button
                        type="button"
                        onClick={() => openUrl("https://hippius.com/privacy-policy")}
                        className="cursor-pointer font-semibold text-primary-50 transition-colors hover:text-primary-60 dark:text-primary-65"
                    >
                        Privacy Policy
                    </button>
                </p>

                <p className="text-[12px] font-medium leading-[18px] tracking-[-0.02em] text-grey-dark-600">
                    Version <AppVersion />
                </p>
            </BackgroundContainer>
        </div>
    );
}
