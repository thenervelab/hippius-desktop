/**
 * Token Validation Hook
 * Validates token exists and is not expired when route changes
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { getApiAuth } from "@/app/lib/helpers/sessionStore";

interface UseTokenValidationConfig {
    onTokenInvalid?: () => Promise<void>;
}

export function useTokenValidation(
    isAuthenticated: boolean,
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

        // Validate token only on route change to protected pages
        const validateToken = async () => {
            try {
                const apiAuth = await getApiAuth();

                // No token or token is expired
                if (!apiAuth?.token) {
                    console.warn("[TokenValidation] No token found on route:", pathname);
                    if (config?.onTokenInvalid) await config.onTokenInvalid();
                    return;
                }

                if (apiAuth.tokenExpiry && apiAuth.tokenExpiry < Date.now()) {
                    console.warn("[TokenValidation] Token expired on route:", pathname);
                    if (config?.onTokenInvalid) await config.onTokenInvalid();
                    return;
                }

                console.log("[TokenValidation] Token valid on route:", pathname);
            } catch (err) {
                console.error("[TokenValidation] Error validating token:", err);
            }
        };

        validateToken();
    }, [pathname, isAuthenticated, config]);
}
