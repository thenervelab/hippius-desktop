import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { oauthService } from "@/app/lib/services/oAuthService";
import { useWalletAuth } from "@/lib/wallet-auth-context";

declare global {
    interface Window {
        __HIPPIUS_OAUTH_DL_LISTENER__?: boolean;
    }
}

export function useOAuthDeepLink() {
    const router = useRouter();
    const { setOAuthSession } = useWalletAuth();

    useEffect(() => {
        if (typeof window === "undefined" || !("__TAURI__" in window)) return;

        // Prevent double-register (RootLayout + ProtectedLayout)
        if (window.__HIPPIUS_OAUTH_DL_LISTENER__) return;
        window.__HIPPIUS_OAUTH_DL_LISTENER__ = true;

        let unlisten: null | (() => void) = null;

        const handleUrl = async (rawUrl: string) => {
            console.log("[useOAuthDeepLink] URL:", rawUrl);

            try {
                const url = new URL(rawUrl);

                const params = {
                    code: url.searchParams.get("code") || undefined,
                    token: url.searchParams.get("token") || undefined,
                    state: url.searchParams.get("state") || undefined,
                    error: url.searchParams.get("error") || undefined,
                    error_description: url.searchParams.get("error_description") || undefined,
                    user: url.searchParams.get("user_id")
                        ? {
                            id: url.searchParams.get("user_id") || undefined,
                            username: url.searchParams.get("username") || undefined,
                            email: url.searchParams.get("email") || undefined,
                            substrate_address: url.searchParams.get("substrate_address") || undefined,
                        }
                        : undefined,
                };

                console.log("[useOAuthDeepLink] Parsed:", params);

                const session = await oauthService.handleCallback(params);
                setOAuthSession(session);

                const redirectPath = sessionStorage.getItem("oauth_redirect") || "/";
                sessionStorage.removeItem("oauth_redirect");

                console.log("[useOAuthDeepLink] Redirect:", redirectPath);
                router.push(redirectPath);
            } catch (e) {
                console.error("[useOAuthDeepLink] Failed:", e);
                router.push("/login?error=oauth_failed");
            }
        };

        (async () => {
            try {
                const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");

                // If app was launched from a deep link
                const urlsAtStart = await getCurrent();
                console.log("[useOAuthDeepLink] getCurrent:", urlsAtStart);
                if (urlsAtStart?.length) {
                    await handleUrl(urlsAtStart[urlsAtStart.length - 1]);
                }

                // If deep link happens while app is running
                unlisten = await onOpenUrl(async (urls) => {
                    console.log("[useOAuthDeepLink] onOpenUrl:", urls);
                    if (urls?.length) {
                        await handleUrl(urls[urls.length - 1]);
                    }
                });

                console.log("[useOAuthDeepLink] Listener ready");
            } catch (e) {
                console.error("[useOAuthDeepLink] Setup failed:", e);
            }
        })();

        return () => {
            if (unlisten) unlisten();
            // Don’t reset the global flag (avoid re-register loops on route changes)
        };
    }, [router, setOAuthSession]);
}
