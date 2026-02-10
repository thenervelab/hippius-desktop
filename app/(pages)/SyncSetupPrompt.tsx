"use client";

import { useState } from "react";
import { useAtom } from "jotai";
import { toast } from "sonner";
import { syncNeedsSetupAtom } from "@/lib/store/syncAtoms";
import { HcfsSetupDialog } from "@/components/page-sections/settings/HcfsSetupDialog";
import { saveHcfsConfig, initializeSync } from "@/lib/utils/hcfsConfigUtils";

/**
 * Invisible component that auto-shows the HcfsSetupDialog when
 * tryAutoInitSync detects a missing HCFS config on login.
 */
export default function SyncSetupPrompt() {
  const [setupInfo, setSetupInfo] = useAtom(syncNeedsSetupAtom);
  const [loading, setLoading] = useState(false);

  if (!setupInfo) return null;

  const handleComplete = async (result: { serverUrl: string; password: string }) => {
    setLoading(true);
    try {
      await saveHcfsConfig(setupInfo.accountId, result.serverUrl, result.password);
      console.log("[SyncSetupPrompt] Config saved, initializing sync...");
      const syncResult = await initializeSync(setupInfo.accountId, setupInfo.mnemonic);
      console.log("[SyncSetupPrompt] Sync initialized:", syncResult.user_id);
      toast.success("Sync setup complete");
      setSetupInfo(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[SyncSetupPrompt] Setup failed:", msg);
      toast.error(`Sync setup failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSetupInfo(null);
  };

  return (
    <HcfsSetupDialog
      open={true}
      onClose={handleClose}
      onComplete={handleComplete}
      loading={loading}
    />
  );
}
