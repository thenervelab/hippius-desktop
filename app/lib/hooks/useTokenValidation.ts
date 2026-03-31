/**
 * Token Validation Hook
 * Validates token exists and is not expired when route changes.
 * Uses the Rust backend for server-side expiry checking.
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";

interface UseTokenValidationConfig {
    onTokenInvalid?: () => Promise<void>;
}

export function useTokenValidation(
    isAuthenticated: boolean,
    accountId: string | null,
    config?: UseTokenValidationConfig
) {
    const pathname = usePathname();
    const prevPathnameRef = useRef<string>("");

    useEffect(() => {
        // Only validate when pathname actually changes
        if (pathname === prevPathnameRef.current) return;
        prevPathnameRef.current = pathname;

        // Skip validation if not authenticated
        if (!isAuthenticated) return;

        // Skip on auth-related paths
        if (pathname === "/login" || pathname === "/auth/callback") {
            return;
        }

        // Skip if we don't have an account to check
        if (!accountId) return;

        // Validate token only on route change to protected pages
        const validateToken = async () => {
            try {
                const valid = await invoke<boolean>("is_token_valid", { accountId });

                if (!valid) {
                    console.warn("[TokenValidation] Token invalid/expired on route:", pathname);
                    if (config?.onTokenInvalid) await config.onTokenInvalid();
                    return;
                }

                console.log("[TokenValidation] Token valid on route:", pathname);
            } catch (err) {
                console.error("[TokenValidation] Error validating token:", err);
            }
        };

        validateToken();
    }, [pathname, isAuthenticated, accountId, config]);
}
