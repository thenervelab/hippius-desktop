"use client";

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

interface PreAuthProviderProps {
    children: React.ReactNode;
}

export default function PreAuthProvider({ children }: PreAuthProviderProps) {
    const { isAuthenticated, polkadotAddress } = useWalletAuth();
    const [authInitialized, setAuthInitialized] = useState(false);

    useEffect(() => {
        if (isAuthenticated && polkadotAddress && !authInitialized) {
            // Single Rust call — checks config internally, skips if not ready
            invoke("ensure_billing_auth", { accountId: polkadotAddress })
                .catch(() => {})
                .finally(() => setAuthInitialized(true));
        }
    }, [isAuthenticated, polkadotAddress, authInitialized]);

    return <>{children}</>;
}
