"use client";

/**
 * Global deep-link listener (audit M-3).
 *
 * Mounted once at the AppShell level — NOT on the login page — because a
 * callback can arrive while the app shows ANY route: the `/auth/callback`
 * error screen of a failed first attempt, the splash, or the home page
 * (macOS redelivers the launching deep link whenever the singleton app is
 * re-activated). When this listener lived inside `LoginForm`, all of
 * those silently dropped the login.
 *
 * Responsibilities are unchanged from the old LoginForm handler: skip
 * initial links after a manual navigation to `/login`, short-circuit to
 * home when a valid session already exists, let Rust parse the URL
 * (`parse_oauth_deep_link` also computes the token-free `dedupKey`), then
 * dedup within a TTL and route to `/auth/callback`. The dedup marker is
 * the opaque `dedupKey` — never the raw URL, whose query can carry a
 * bearer token on the legacy direct grant (audit S-1) — and it expires
 * after `DEEP_LINK_DEDUP_TTL_MS` so re-clicking the console's "Open
 * Hippius" button after a failed attempt retries instead of being
 * silently ignored forever (audit M-4).
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { isTauri } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { isDeepLinkAlreadyProcessed } from "@/app/lib/auth/deepLinkDedup";
import {
  OAUTH_SESSION_EXPIRY_KEY,
  OAUTH_SESSION_KEY,
} from "@/app/lib/auth/oauthSessionHint";

export default function DeepLinkListener() {
  const router = useRouter();
  const { isAuthenticated } = useWalletAuth();
  // Ref so the long-lived deep-link subscription reads the CURRENT auth
  // state at event time instead of the value captured at mount.
  const isAuthenticatedRef = useRef(isAuthenticated);
  useEffect(() => {
    isAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated]);

  useEffect(() => {
    if (typeof window === "undefined" || !isTauri()) return;

    let unlisten: null | (() => void) = null;
    let initialDeepLinkProcessed = false;

    const handleDeepLink = async (url: string, isInitial = false) => {
      try {
        // Skip initial deep links if the user manually navigated to login
        const manualNavigation = sessionStorage.getItem("manual_navigation");
        if (manualNavigation === "true" && isInitial) {
          console.log(
            "[DeepLinkListener] Skipping initial deep link due to manual navigation",
          );
          sessionStorage.removeItem("manual_navigation");
          return;
        }

        // Parse FIRST (Rust handles URL fixup, session param extraction,
        // callback path construction, and the token-free dedupKey). Every
        // guard below applies only to OAuth callbacks: this listener is
        // global now, and non-OAuth deep links — e.g. the Finder
        // extension's `hippiusapp://open`, which merely activates the app
        // — must be a complete no-op here, not a redirect (PR #106
        // review: the old pre-parse session check yanked an OAuth user
        // to "/" whenever ANY deep link arrived).
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{
          isCallback: boolean;
          callbackPath: string | null;
          dedupKey: string | null;
        }>("parse_oauth_deep_link", { url });

        if (!(result.isCallback && result.callbackPath)) {
          return;
        }

        // A live session (any auth type — mnemonic sessions never touch
        // the OAuth localStorage keys) must not be hijacked by a stray
        // or redelivered callback: processing it would drive the user
        // into /auth/callback and overwrite the active session.
        if (isAuthenticatedRef.current) {
          console.log(
            "[DeepLinkListener] Ignoring OAuth callback — a session is already active",
          );
          return;
        }

        // Boot window: the auth context may not have restored yet, but a
        // valid persisted OAuth session means this callback is a
        // redelivery, not a login in progress — go home instead of
        // reprocessing it (mirrors /auth/callback's own guard).
        const storedSession = localStorage.getItem(OAUTH_SESSION_KEY);
        const storedExpiry = localStorage.getItem(OAUTH_SESSION_EXPIRY_KEY);
        if (storedSession && storedExpiry) {
          const expiryTime = isNaN(Number(storedExpiry))
            ? new Date(storedExpiry).getTime()
            : parseInt(storedExpiry, 10);
          if (Date.now() < expiryTime) {
            console.log(
              "[DeepLinkListener] User already has valid session, redirecting to home",
            );
            router.replace("/");
            return;
          }
        }

        // Dedup: skip only a RECENT redelivery of an already-routed
        // callback (macOS re-sends the launching link on activation).
        const stored = localStorage.getItem("last_processed_deep_link");
        const storedAtRaw = localStorage.getItem(
          "last_processed_deep_link_time",
        );
        const storedAtMs = storedAtRaw === null ? null : Number(storedAtRaw);
        if (
          isDeepLinkAlreadyProcessed(
            stored,
            storedAtMs,
            Date.now(),
            url,
            result.dedupKey,
          )
        ) {
          console.log("[DeepLinkListener] Deep link already processed, skipping");
          return;
        }

        // NOTE: callbackPath carries the OAuth credentials — never log it.
        console.log("[DeepLinkListener] Redirecting to OAuth callback page");
        if (result.dedupKey) {
          localStorage.setItem("last_processed_deep_link", result.dedupKey);
        }
        localStorage.setItem(
          "last_processed_deep_link_time",
          Date.now().toString(),
        );
        router.push(result.callbackPath);
      } catch (e) {
        console.error("[DeepLinkListener] Failed to process deep link:", e);
      }
    };

    (async () => {
      try {
        const { getCurrent, onOpenUrl } = await import(
          "@tauri-apps/plugin-deep-link"
        );

        // 1) App started via deep link — process once.
        const current = await getCurrent();
        if (current?.length && !initialDeepLinkProcessed) {
          initialDeepLinkProcessed = true;
          handleDeepLink(current[current.length - 1], true);
        }

        // 2) Deep link arrives while the app is open.
        unlisten = await onOpenUrl((urls) => {
          if (urls?.length) {
            // A fresh delivery overrides a prior manual navigation.
            sessionStorage.removeItem("manual_navigation");
            handleDeepLink(urls[urls.length - 1], false);
          }
        });
      } catch (e) {
        console.error("[DeepLinkListener] setup failed:", e);
      }
    })();

    return () => {
      if (unlisten) unlisten();
    };
  }, [router]);

  return null;
}
