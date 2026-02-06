import { useEffect, useState } from "react";
import {
  getPrivateSyncPath,
} from "@/lib/utils/syncPathUtils";
import { useSetAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";

export function useFilesNavigation() {
  const [privateSyncPathConfigured, setPrivateSyncPathConfigured] = useState<
    boolean | null
  >(null);
  const [isLoading, setIsLoading] = useState(true);
  const setActiveSubMenuItem = useSetAtom(activeSubMenuItemAtom);

  useEffect(() => {
    async function checkSyncPaths() {
      try {
        setIsLoading(true);
        const privatePath = await getPrivateSyncPath();
        setPrivateSyncPathConfigured(!!privatePath);
      } catch (error) {
        console.error("Failed to check sync paths:", error);
        setPrivateSyncPathConfigured(false);
      } finally {
        setIsLoading(false);
      }
    }

    checkSyncPaths();
  }, []);

  // Determine which view to navigate to based on configured paths
  const getTargetFilesView = () => {
    if (privateSyncPathConfigured) return "Private";
    return "";
  };

  // Navigate to the appropriate view
  const navigateToFilesView = () => {
    const targetView = getTargetFilesView();
    setActiveSubMenuItem(targetView);
  };

  return {
    privateSyncPathConfigured,
    publicSyncPathConfigured: false,
    isLoading,
    getTargetFilesView,
    navigateToFilesView,
  };
}
