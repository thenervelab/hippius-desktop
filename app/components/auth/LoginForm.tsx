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
import { RecoverAccountDialog } from "./RecoverAccountDialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { useRouter } from "next/navigation";
import { LogoMark } from "@/components/ui/LogoMark";

export function LoginForm({
  onHideHeaderChange,
}: {
  onHideHeaderChange?: (hide: boolean) => void;
}) {
  const [showAccessKeyForm, setShowAccessKeyForm] = useState(false);
  const [showRecover, setShowRecover] = useState(false);
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
  // Env-gated so a production build can never ship the panel enabled:
  // the flag is unset in normal builds, so this resolves to `false`.
  // Enable it for an OAuth/recovery debugging session with
  //     NEXT_PUBLIC_DEV_OAUTH_INJECTOR=1 pnpm tauri:dev   (or tauri:static)
  // Next.js inlines NEXT_PUBLIC_* at `next build`, so the comparison is
  // a compile-time constant — no runtime env access in the static export.
  // Tracked with the `DEV_OAUTH_INJECTOR` comment — grep for it when cleaning up.
  const showDevOAuthInjector =
    process.env.NEXT_PUBLIC_DEV_OAUTH_INJECTOR === "1"; // DEV_OAUTH_INJECTOR
  const [devOAuthUrl, setDevOAuthUrl] = useState("");
  const [devOAuthStatus, setDevOAuthStatus] = useState<string | null>(null);

  const handleDevInjectOAuthUrl = async () => {
    const trimmed = devOAuthUrl.trim();
    if (!trimmed) return;
    try {
      setDevOAuthStatus("Parsing...");
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{
        isCallback: boolean;
        callbackPath: string | null;
      }>("parse_oauth_deep_link", { url: trimmed });
      if (result.isCallback && result.callbackPath) {
        setDevOAuthStatus(`Routing to ${result.callbackPath}`);
        localStorage.setItem("last_processed_deep_link", trimmed);
        localStorage.setItem(
          "last_processed_deep_link_time",
          Date.now().toString(),
        );
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
        const lastProcessedUrl = localStorage.getItem(
          "last_processed_deep_link",
        );
        if (lastProcessedUrl === url) {
          console.log("[LoginForm] Deep link already processed, skipping");
          localStorage.setItem(
            "last_processed_deep_link_time",
            Date.now().toString(),
          );
          return;
        }

        // Skip initial deep links if user manually navigated to login
        const manualNavigation = sessionStorage.getItem("manual_navigation");
        if (manualNavigation === "true" && isInitial) {
          console.log(
            "[LoginForm] Skipping initial deep link due to manual navigation",
          );
          sessionStorage.removeItem("manual_navigation");
          return;
        }

        // Skip if user already has a valid session
        const storedSession = localStorage.getItem("hippius_oauth_session");
        const storedExpiry = localStorage.getItem(
          "hippius_oauth_session_expiry",
        );
        if (storedSession && storedExpiry) {
          const expiryTime = isNaN(Number(storedExpiry))
            ? new Date(storedExpiry).getTime()
            : parseInt(storedExpiry, 10);
          if (Date.now() < expiryTime) {
            console.log(
              "[LoginForm] User already has valid session, redirecting to home",
            );
            router.replace("/");
            return;
          }
        }

        // Rust handles URL parsing, malformed URL fixup, session param extraction,
        // and callback path construction
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{
          isCallback: boolean;
          callbackPath: string | null;
        }>("parse_oauth_deep_link", { url });

        if (result.isCallback && result.callbackPath) {
          console.log(
            "[LoginForm] Redirecting to callback page:",
            result.callbackPath,
          );
          localStorage.setItem("last_processed_deep_link", url);
          localStorage.setItem(
            "last_processed_deep_link_time",
            Date.now().toString(),
          );
          router.push(result.callbackPath);
        }
      } catch (e) {
        console.error("[LoginForm] Failed to process deep link:", e);
      }
    };

    (async () => {
      try {
        const { getCurrent, onOpenUrl } =
          await import("@tauri-apps/plugin-deep-link");

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
    <div className="opacity-0 animate-fade-in-0.5 w-full flex justify-center">
      <div
        className="w-full max-w-[495px] bg-[#fffdff]  dark:bg-[#161416] rounded-[8px] p-[min(1rem,16px)] flex flex-col gap-[min(0.75rem,12px)] items-center overflow-hidden"
        style={{
          boxShadow:
            "0px 14px 31px 0px rgba(0,0,0,0.06), 0px 56px 56px 0px rgba(0,0,0,0.05), 0px 126px 76px 0px rgba(0,0,0,0.03), 0px 224px 90px 0px rgba(0,0,0,0.01)",
        }}
      >
        <LogoMark />

        <h1 className="w-full text-center text-grey-10 dark:text-grey-light-100 font-medium text-[min(1.75rem,28px)] leading-[min(2.25rem,36px)] tracking-[-0.03em]">
          Sign In to Hippius
        </h1>

        <div className="flex flex-col gap-[min(1rem,16px)] items-center w-full">
          <OAuthButtonsGroup
            onAccessKeyClick={() => setShowAccessKeyForm(true)}
          />

          {showDevOAuthInjector && (
            <div className="w-full rounded-lg border border-dashed border-grey-80 bg-grey-light-500 p-3">
              <p className="mb-2 text-xs font-semibold text-grey-20">
                Dev: inject OAuth callback URL
              </p>
              <p className="mb-2 text-[10px] text-grey-40">
                Paste the <code>hippiusapp://auth/callback?...</code> URL.
              </p>
              <textarea
                value={devOAuthUrl}
                onChange={(e) => setDevOAuthUrl(e.target.value)}
                placeholder="hippiusapp://auth/callback?code=...&state=...&username=...&id=..."
                className="mb-2 h-20 w-full rounded border border-grey-80 bg-white p-2 font-mono text-[11px] text-grey-10"
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
                  <span className="text-[10px] text-grey-40">
                    {devOAuthStatus}
                  </span>
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowRecover(true)}
            className="w-full text-center text-[min(0.875rem,14px)] font-medium text-primary-50 dark:text-primary-65 hover:text-primary-60 transition-colors cursor-pointer"
          >
            Recover an account with your seed phrase
          </button>

          <div className="h-px w-full bg-grey-80 dark:bg-[#494949]" />

          <p className="w-full text-center text-[min(0.75rem,12px)] leading-[min(1.125rem,18px)] tracking-[-0.02em] text-grey-dark-800 font-medium">
            By continuing you agree to our
            <br />
            <button
              type="button"
              onClick={() =>
                openUrl("https://hippius.com/terms-and-conditions")
              }
              className="font-semibold text-primary-50 dark:text-primary-65 hover:text-primary-60 transition-colors cursor-pointer"
            >
              Terms and Conditions
            </button>{" "}
            and{" "}
            <button
              type="button"
              onClick={() => openUrl("https://hippius.com/privacy-policy")}
              className="font-semibold text-primary-50 dark:text-primary-65 hover:text-primary-60 transition-colors cursor-pointer"
            >
              Privacy Policy
            </button>
          </p>

          <p className="text-[min(0.75rem,12px)] leading-[min(1.125rem,18px)] tracking-[-0.02em] text-grey-dark-600 font-medium">
            Version {version}
          </p>
        </div>
      </div>

      <RecoverAccountDialog open={showRecover} onClose={() => setShowRecover(false)} />
    </div>
  );
}
