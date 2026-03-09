"use client";

import { useEffect, useState } from "react";
import { useWalletAuth } from "@/lib/wallet-auth-context";
import { ensureBillingAuth } from "@/app/lib/hooks/api/useBillingAuth";
import { getHcfsConfig } from "@/lib/utils/hcfsConfigUtils";

interface PreAuthProviderProps {
    children: React.ReactNode;
}

export default function PreAuthProvider({ children }: PreAuthProviderProps) {
    const { isAuthenticated, polkadotAddress } = useWalletAuth();
    const [authInitialized, setAuthInitialized] = useState(false);

    useEffect(() => {
        if (isAuthenticated && polkadotAddress && !authInitialized) {
            (async () => {
                try {
                    // Only attempt billing auth if HCFS config exists
                    // (mnemonic on disk is needed to sign the challenge)
                    const config = await getHcfsConfig(polkadotAddress);
                    if (config.has_password) {
                        await ensureBillingAuth(polkadotAddress);
                    }
                } finally {
                    setAuthInitialized(true);
                }
            })();
        }
    }, [isAuthenticated, polkadotAddress, authInitialized]);

    return <>{children}</>;
}
