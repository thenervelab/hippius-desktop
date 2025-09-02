"use client";

import { useEffect, useState } from "react";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";

interface PreAuthProviderProps {
    children: React.ReactNode;
}

export default function PreAuthProvider({ children }: PreAuthProviderProps) {
    const { isAuthenticated } = useWalletAuth();
    const [authInitialized, setAuthInitialized] = useState(false);

    useEffect(() => {
        if (isAuthenticated && !authInitialized) {
            // Initialize billing auth token once user is logged in
            (async () => {
                try {
                    await ensureBillingAuth();
                } finally {
                    setAuthInitialized(true);
                }
            })();
        }
    }, [isAuthenticated, authInitialized]);

    return <>{children}</>;
}
