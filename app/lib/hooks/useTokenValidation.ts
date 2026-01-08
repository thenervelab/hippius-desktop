/**
 * Token Validation Hook
 * Validates token exists and is not expired
 * Runs on route changes and checks periodically
 */

import { useEffect, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { getApiAuth } from "@/app/lib/helpers/sessionStore";

interface UseTokenValidationConfig {
    onTokenInvalid?: () => Promise<void>;
    skipPaths?: string[]; // Paths to skip validation (e.g., /login)
}

export function useTokenValidation(
    isAuthenticated: boolean,
    config?: UseTokenValidationConfig
) {
    const pathname = usePathname();
    const authCheckDoneRef = useRef(false);

    const validateToken = useCallback(async () => {
        // Skip validation if not authenticated
        if (!isAuthenticated) {
            authCheckDoneRef.current = false;
            return;
        }

        // Skip on auth-related paths
        if (pathname === "/login" || pathname === "/auth/callback" || pathname === "/") {
            return;
        }
        if (config?.skipPaths?.includes(pathname)) return;

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
    }, [isAuthenticated, pathname, config]);

    // Validate on route change (but only after initial auth is done)
    useEffect(() => {
        if (!isAuthenticated) return;
        if (authCheckDoneRef.current === false) {
            authCheckDoneRef.current = true;
            // Small delay to ensure token is set during login flow
            setTimeout(() => validateToken(), 500);
        } else {
            validateToken();
        }
    }, [validateToken, isAuthenticated]);

    // Validate periodically (every 30 seconds) - only when authenticated
    useEffect(() => {
        if (!isAuthenticated) return;
        if (pathname === "/login" || pathname === "/auth/callback" || pathname === "/") {
            return;
        }
        if (config?.skipPaths?.includes(pathname)) return;

        const interval = setInterval(validateToken, 30000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, pathname]);
}
