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
import { isTauri } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";

export function LoginForm({
    onHideHeaderChange,
}: {
    onHideHeaderChange?: (hide: boolean) => void;
}) {
    const [showAccessKeyForm, setShowAccessKeyForm] = useState(false);
    const [version, setVersion] = useState<string>("");
    const router = useRouter();

    // Dev OAuth callback URL injector. In `pnpm tauri:dev` / `pnpm tauri:static`
    // builds the macOS deep-link routing to `hippiusapp://` usually points at the
    // installed .app, not the dev binary, so we can't test OAuth end-to-end
    // without a full DMG rebuild. This panel short-circuits that: paste the
    // callback URL the browser produced (copy it from the Network tab or the
    // console's "Deep link URL" log on console.hippius.com/auth/callback),
    // hit "Inject", and the app routes through exactly the same Rust logic a
    // real deep link would trigger.
    //
    // TODO: remove this panel before shipping to production. It's an active-
    // debugging aid for OAuth recovery. Tracked with the `DEV_OAUTH_INJECTOR`
    // comment — grep for it when cleaning up.
    const showDevOAuthInjector = true; // DEV_OAUTH_INJECTOR
    const [devOAuthUrl, setDevOAuthUrl] = useState("");
    const [devOAuthStatus, setDevOAuthStatus] = useState<string | null>(null);

    const handleDevInjectOAuthUrl = async () => {
        const trimmed = devOAuthUrl.trim();
        if (!trimmed) return;
        try {
            setDevOAuthStatus("Parsing...");
            const { invoke } = await import("@tauri-apps/api/core");
            const result = await invoke<{ isCallback: boolean; callbackPath: string | null }>(
                "parse_oauth_deep_link",
                { url: trimmed },
            );
            if (result.isCallback && result.callbackPath) {
                setDevOAuthStatus(`Routing to ${result.callbackPath}`);
                localStorage.setItem("last_processed_deep_link", trimmed);
                localStorage.setItem("last_processed_deep_link_time", Date.now().toString());
                router.push(result.callbackPath);
            } else {
                setDevOAuthStatus("Not an OAuth callback URL.");
            }
        } catch (e: any) {
            setDevOAuthStatus(`Error: ${e?.message || String(e)}`);
        }
    };

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
        if (typeof window === "undefined" || !isTauri()) return;

        let unlisten: null | (() => void) = null;
        let initialDeepLinkProcessed = false;

        const handleDeepLink = async (url: string, isInitial = false) => {
            try {
                // Dedup: skip if this URL was already processed (persists across restarts)
                const lastProcessedUrl = localStorage.getItem("last_processed_deep_link");
                if (lastProcessedUrl === url) {
                    console.log("[LoginForm] Deep link already processed, skipping");
                    localStorage.setItem("last_processed_deep_link_time", Date.now().toString());
                    return;
                }

                // Skip initial deep links if user manually navigated to login
                const manualNavigation = sessionStorage.getItem("manual_navigation");
                if (manualNavigation === "true" && isInitial) {
                    console.log("[LoginForm] Skipping initial deep link due to manual navigation");
                    sessionStorage.removeItem("manual_navigation");
                    return;
                }

                // Skip if user already has a valid session
                const storedSession = localStorage.getItem("hippius_oauth_session");
                const storedExpiry = localStorage.getItem("hippius_oauth_session_expiry");
                if (storedSession && storedExpiry) {
                    const expiryTime = isNaN(Number(storedExpiry))
                        ? new Date(storedExpiry).getTime()
                        : parseInt(storedExpiry, 10);
                    if (Date.now() < expiryTime) {
                        console.log("[LoginForm] User already has valid session, redirecting to home");
                        router.replace("/");
                        return;
                    }
                }

                // Rust handles URL parsing, malformed URL fixup, session param extraction,
                // and callback path construction
                const { invoke } = await import("@tauri-apps/api/core");
                const result = await invoke<{ isCallback: boolean; callbackPath: string | null }>(
                    "parse_oauth_deep_link", { url }
                );

                if (result.isCallback && result.callbackPath) {
                    console.log("[LoginForm] Redirecting to callback page:", result.callbackPath);
                    localStorage.setItem("last_processed_deep_link", url);
                    localStorage.setItem("last_processed_deep_link_time", Date.now().toString());
                    router.push(result.callbackPath);
                }
            } catch (e) {
                console.error("[LoginForm] Failed to process deep link:", e);
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
            <div className="space-y-[min(1.5rem,24px)] text-grey-10 w-full">
                <Typography.P size="xl" className="text-grey-10 font-medium !text-[min(2rem,32px)]">
                    Log In to Hippius
                </Typography.P>

                <div className="space-y-[min(0.5rem,8px)]">
                    <OAuthButtonsGroup onAccessKeyClick={() => setShowAccessKeyForm(true)} />
                </div>

                {showDevOAuthInjector && (
                    <div className="mt-4 rounded-lg border border-dashed border-grey-80 bg-grey-95 p-3 dark:border-[#353535] dark:bg-[#202020]">
                        <p className="mb-2 text-xs font-semibold text-grey-20 dark:text-white">
                            Dev: inject OAuth callback URL
                        </p>
                        <p className="mb-2 text-[10px] text-grey-40 dark:text-[#a1a1a1]">
                            Paste the <code>hippiusapp://auth/callback?...</code> (or raw console callback)
                            URL from the browser to bypass OS deep-link routing.
                        </p>
                        <textarea
                            value={devOAuthUrl}
                            onChange={(e) => setDevOAuthUrl(e.target.value)}
                            placeholder="hippiusapp://auth/callback?code=...&state=...&username=...&id=..."
                            className="mb-2 h-20 w-full rounded border border-grey-80 bg-white p-2 font-mono text-[11px] text-grey-10 dark:border-[#353535] dark:bg-[#161616] dark:text-white"
                        />
                        <div className="flex items-center justify-between gap-2">
                            <button
                                type="button"
                                onClick={handleDevInjectOAuthUrl}
                                className="rounded bg-primary-50 px-3 py-1 text-xs font-medium text-white hover:bg-primary-60"
                            >
                                Inject
                            </button>
                            {devOAuthStatus && (
                                <span className="text-[10px] text-grey-40 dark:text-[#a1a1a1]">
                                    {devOAuthStatus}
                                </span>
                            )}
                        </div>
                    </div>
                )}
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

            <div className="text-center mt-[min(1rem,16px)]">
                <p className="text-[min(0.75rem,12px)] text-grey-60 font-semibold">
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

            <div className="mt-[min(0.5rem,8px)] text-center text-[min(0.75rem,12px)] text-grey-70 font-medium">
                <p>Version {version}</p>
            </div>
        </div>
    );
}
