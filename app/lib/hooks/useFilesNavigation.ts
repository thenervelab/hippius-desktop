import { useEffect, useState } from "react";
import { getPrivateSyncPath, getPublicSyncPath } from "@/lib/utils/syncPathUtils";
import { useSetAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";

export function useFilesNavigation() {
    const [privateSyncPathConfigured, setPrivateSyncPathConfigured] = useState<boolean | null>(null);
    const [publicSyncPathConfigured, setPublicSyncPathConfigured] = useState<boolean | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);

    useEffect(() => {
        async function checkSyncPaths() {
            try {
                setIsLoading(true);

                // Check both paths in parallel
                const [privatePath, publicPath] = await Promise.all([
                    getPrivateSyncPath(),
                    getPublicSyncPath()
                ]);

                setPrivateSyncPathConfigured(!!privatePath);
                setPublicSyncPathConfigured(!!publicPath);
            } catch (error) {
                console.error("Failed to check sync paths:", error);
                setPrivateSyncPathConfigured(false);
                setPublicSyncPathConfigured(false);
            } finally {
                setIsLoading(false);
            }
        }

        checkSyncPaths();
    }, []);

    // Determine which view to navigate to based on configured paths
    // and file counts (optional)
    const getTargetFilesView = (privateFileCount = 0, publicFileCount = 0) => {
        // If both are configured, use file counts to decide
        if (privateSyncPathConfigured && publicSyncPathConfigured) {
            // If we have file counts, use them to make a decision
            if (privateFileCount > 0 || publicFileCount > 0) {
                return privateFileCount >= publicFileCount ? "Private" : "Public";
            }
            // Default to Private when both are configured but we don't have counts
            return "Private";
        }

        // If only one is configured, use that one
        if (privateSyncPathConfigured) return "Private";
        if (publicSyncPathConfigured) return "Public";

        // Default case: neither is configured
        return "Private"; // Default to Private view
    };

    // Navigate to the appropriate view
    const navigateToFilesView = (privateFileCount = 0, publicFileCount = 0) => {
        const targetView = getTargetFilesView(privateFileCount, publicFileCount);
        setActiveSubMenuItem(targetView);
    };

    return {
        privateSyncPathConfigured,
        publicSyncPathConfigured,
        isLoading,
        getTargetFilesView,
        navigateToFilesView
    };
}
