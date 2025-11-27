/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Main Login Form Component
 *
 * Displays OAuth login options (Google, Apple, GitHub) and Access Key option.
 * Handles switching between OAuth flow and traditional access key authentication.
 */

"use client";

import { useState, useEffect } from "react";
import { OAuthButtonsGroup } from "./OAuthButtons";
import { AccessKeyLoginForm } from "./AccessKeyLoginForm";
import * as Typography from "@/components/ui/typography";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { useRouter } from "next/navigation";

export function LoginForm({
    onHideHeaderChange,
}: {
    onHideHeaderChange?: (hide: boolean) => void;
}) {
    const [showAccessKeyForm, setShowAccessKeyForm] = useState(false);
    const [version, setVersion] = useState<string>("");
    const router = useRouter();

    // ✅ Deep link debug state (temporary)
    // const [dlRaw, setDlRaw] = useState<string | null>(null);
    // const [dlLogs, setDlLogs] = useState<string[]>([]);

    // const addDlLog = (msg: string) => {
    //     const t = new Date().toISOString().split("T")[1].slice(0, 12);
    //     setDlLogs((p) => [...p, `[${t}] ${msg}`]);
    // };

    // const dlParsed = useMemo(() => {
    //     if (!dlRaw) return null;
    //     try {
    //         const u = new URL(dlRaw);
    //         return {
    //             scheme: u.protocol.replace(":", ""),
    //             host: u.host,
    //             path: u.pathname,
    //             params: Object.fromEntries(u.searchParams.entries()),
    //         };
    //     } catch {
    //         return { raw: dlRaw };
    //     }
    // }, [dlRaw]);

    useEffect(() => {
        getVersion().then((v) => setVersion(v));
    }, []);

    useEffect(() => {
        // Notify parent when header visibility should change
        if (onHideHeaderChange) {
            onHideHeaderChange(showAccessKeyForm);
        }
    }, [showAccessKeyForm, onHideHeaderChange]);

    // Clear deep link state when component unmounts (user navigates away)
    useEffect(() => {
        return () => {
            // Cleanup when leaving login page
            // setDlRaw(null);
            // setDlLogs([]);
            console.log("[LoginForm] Deep link state cleared on unmount");
        };
    }, []);

    // ✅ Deep link handler - processes OAuth callbacks and redirects to /auth/callback
    useEffect(() => {
        if (typeof window === "undefined" || !("__TAURI__" in window)) return;

        let unlisten: null | (() => void) = null;
        let initialDeepLinkProcessed = false;

        const handleDeepLink = (url: string, isInitial = false) => {
            // addDlLog(`Received URL: ${url}`);
            // setDlRaw(url);

            try {
                // Check if this deep link has already been processed
                const lastProcessedUrl = sessionStorage.getItem("last_processed_deep_link");
                if (lastProcessedUrl === url) {
                    // addDlLog("⚠️ This deep link was already processed, skipping");
                    console.log("[LoginForm] Deep link already processed, skipping:", url);
                    return;
                }

                // If user manually navigated to login, don't process old deep links
                const manualNavigation = sessionStorage.getItem("manual_navigation");
                if (manualNavigation === "true" && isInitial) {
                    // addDlLog("⚠️ Manual navigation detected, skipping initial deep link");
                    console.log("[LoginForm] Skipping initial deep link due to manual navigation");
                    sessionStorage.removeItem("manual_navigation");
                    return;
                }

                const urlObj = new URL(url);
                // addDlLog(`Parsed - scheme: ${urlObj.protocol}, path: ${urlObj.pathname}`);

                // Check if this is an OAuth callback
                if (urlObj.pathname.includes("/auth/callback")) {
                    // addDlLog("✅ OAuth callback detected, extracting parameters...");

                    // Extract all query parameters
                    const params = new URLSearchParams(urlObj.search);
                    const token = params.get("token");
                    const code = params.get("code");
                    const username = params.get("username");
                    const email = params.get("email");
                    const userId = params.get("user_id");
                    const substrateAddress = params.get("substrate_address");
                    const error = params.get("error");
                    const errorDescription = params.get("error_description");

                    // Also check for 'session' parameter with JSON data
                    const sessionParam = params.get("session");
                    if (sessionParam) {
                        try {
                            const sessionData = JSON.parse(decodeURIComponent(sessionParam));
                            // addDlLog(`Session parameter found: ${JSON.stringify(sessionData)}`);
                            // Extract data from session object
                            if (sessionData.code && !code) params.set("code", sessionData.code);
                            if (sessionData.username && !username) params.set("username", sessionData.username);
                            if (sessionData.id && !userId) params.set("user_id", sessionData.id);
                        } catch (e) {
                            console.log("[LoginForm] Failed to parse session parameter:", e);
                            // addDlLog(`Failed to parse session parameter: ${e}`);
                        }
                    }

                    // addDlLog(`Parameters - token: ${token ? "present" : "missing"}, code: ${code || params.get("code") ? "present" : "missing"}, username: ${username || params.get("username") || "missing"}`);

                    // Build callback URL with parameters
                    const callbackParams = new URLSearchParams();
                    if (token || params.get("token")) callbackParams.set("token", token || params.get("token")!);
                    if (code || params.get("code")) callbackParams.set("code", code || params.get("code")!);
                    if (username || params.get("username")) callbackParams.set("username", username || params.get("username")!);
                    if (email) callbackParams.set("email", email);
                    if (userId || params.get("user_id")) callbackParams.set("user_id", userId || params.get("user_id")!);
                    if (substrateAddress) callbackParams.set("substrate_address", substrateAddress);
                    if (error) callbackParams.set("error", error);
                    if (errorDescription) callbackParams.set("error_description", errorDescription);

                    const callbackUrl = `/auth/callback?${callbackParams.toString()}`;
                    // addDlLog(`✅ Redirecting to: ${callbackUrl}`);
                    console.log("[LoginForm] Redirecting to callback page:", callbackUrl);

                    // Mark this deep link as processed BEFORE redirecting
                    sessionStorage.setItem("last_processed_deep_link", url);
                    console.log("[LoginForm] Marked deep link as processed");

                    // Redirect to callback page
                    router.push(callbackUrl);

                    // Clear deep link state after initiating redirect
                    // This ensures state is clean when user returns to login
                    setTimeout(() => {
                        // setDlRaw(null);
                        // setDlLogs([]);
                        console.log("[LoginForm] Deep link state cleared after redirect");
                    }, 500);
                } else {
                    // addDlLog(`ℹ️ Non-callback deep link: ${urlObj.pathname}`);
                }
            } catch (e: any) {
                // addDlLog(`Failed to parse URL: ${e?.message || String(e)}`);
                console.error("[LoginForm] Failed to parse deep link:", e);
            }
        };

        (async () => {
            try {
                const { getCurrent, onOpenUrl } = await import(
                    "@tauri-apps/plugin-deep-link"
                );

                // addDlLog("Deep link listener starting...");

                // 1) If app started via deep link - only process once
                const current = await getCurrent();
                // addDlLog(`getCurrent(): ${JSON.stringify(current)}`);
                if (current?.length && !initialDeepLinkProcessed) {
                    initialDeepLinkProcessed = true;
                    handleDeepLink(current[current.length - 1], true);
                }

                // 2) If deep link arrives while app is open - these are NEW deep links
                unlisten = await onOpenUrl((urls) => {
                    // addDlLog(`onOpenUrl(): ${JSON.stringify(urls)}`);
                    if (urls?.length) {
                        // Clear manual navigation flag since this is a new deep link
                        sessionStorage.removeItem("manual_navigation");
                        handleDeepLink(urls[urls.length - 1], false);
                    }
                });

                // addDlLog("Deep link listener registered ✅");
            } catch (e: any) {
                // addDlLog(`Deep link setup failed: ${e?.message || String(e)}`);
                console.error("[LoginForm deep link] setup failed:", e);
            }
        })();

        return () => {
            if (unlisten) unlisten();
        };
    }, [router]);

    if (showAccessKeyForm) {
        return <AccessKeyLoginForm onBack={() => setShowAccessKeyForm(false)} />;
    }

    return (
        <div className="opacity-0 animate-fade-in-0.5 w-full">
            <div className="space-y-6 text-grey-10 w-full">
                <Typography.P size="xl" className="text-grey-10 font-medium !text-[32px]">
                    Log In to Hippius
                </Typography.P>

                <div className="space-y-2">
                    <OAuthButtonsGroup onAccessKeyClick={() => setShowAccessKeyForm(true)} />
                </div>
            </div>

            {/* ✅ Deep link debug panel (remove later) */}
            {/* <div className="mt-4 rounded-lg border border-grey-90 bg-grey-95 p-3">
                <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-grey-20">Deep link debug</p>

                    <button
                        onClick={() => {
                            setDlRaw(null);
                            setDlLogs([]);
                        }}
                        className="text-xs text-primary-50 hover:underline"
                    >
                        Clear
                    </button>
                </div>

                <div className="mt-2 space-y-2">
                    <div className="text-xs text-grey-40 font-mono break-all">
                        <div className="text-grey-20 font-semibold mb-1">Last URL</div>
                        {dlRaw || "— (none received yet)"}
                    </div>

                    <div className="text-xs text-grey-40 font-mono">
                        <div className="text-grey-20 font-semibold mb-1">Parsed</div>
                        <pre className="whitespace-pre-wrap break-all">
                            {JSON.stringify(dlParsed, null, 2)}
                        </pre>
                    </div>

                    <div className="text-xs text-grey-40 font-mono">
                        <div className="text-grey-20 font-semibold mb-1">Logs</div>
                        <div className="max-h-40 overflow-y-auto space-y-1">
                            {dlLogs.length ? (
                                dlLogs.map((l, i) => (
                                    <div key={i} className="border-b border-grey-90 pb-1">
                                        {l}
                                    </div>
                                ))
                            ) : (
                                <div>—</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <button
                onClick={() => {
                    console.log("[LoginForm] Testing callback with token...");
                    router.push(
                        "/auth/callback?code=4079f037e61943db802a081cb7d6e4603cb09b1af28f51a72975ad06d6a723b2&username=ahmad_rao&id=1333"
                    );
                }}
                className="mt-4 block w-full text-center text-sm text-primary-50 hover:text-primary-60 font-medium hover:underline"
            >
                🧪 Test Callback (Dev Only)
            </button> */}

            <div className="text-center mt-4">
                <p className="text-xs text-grey-60 font-semibold">
                    By continuing, you agree to our{" "}
                    <button
                        onClick={() => openUrl("https://hippius.com/terms-and-conditions")}
                        className="text-primary-50 font-semibold hover:text-primary-60 transition-colors cursor-pointer"
                    >
                        Terms and Conditions
                    </button>{" "}
                    and{" "}
                    <button
                        onClick={() => openUrl("https://hippius.com/privacy-policy")}
                        className="text-primary-50 font-semibold hover:text-primary-60 transition-colors cursor-pointer"
                    >
                        Privacy Policy
                    </button>
                </p>
            </div>

            <div className="mt-2 text-center text-xs text-grey-70 font-medium">
                <p>Version {version}</p>
            </div>
        </div>
    );
}
