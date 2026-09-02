"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { InView } from "react-intersection-observer";
import { Key, Lock } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { MnemonicBackupDialog } from "./MnemonicBackupDialog";
import { SettingsWarningNotice } from "./SettingsWarningNotice";
import ChangeRecoveryPasswordDialog from "@/components/recovery/ChangeRecoveryPasswordDialog";
import SetRecoveryPasswordDialog from "@/components/recovery/SetRecoveryPasswordDialog";
import { checkRecoveryState } from "@/app/lib/utils/recovery";
import type { RecoveryCheck } from "@/app/lib/global-atoms/recoveryAtoms";
import { cn } from "@/lib/utils";

interface SecurityRowProps {
  Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}

/**
 * Flat horizontal row used in the Security section (mnemonic seed,
 * unlock password). Icon + title/description on the left, primary
 * action button on the right.
 */
function SecurityRow({
  Icon,
  title,
  description,
  actionLabel,
  onAction,
}: SecurityRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-[8px] border border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300">
      <div className="flex items-start gap-3 min-w-0">
        <Icon className="size-[18px] text-primary-50 dark:text-primary-brand-dark flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-grey-10 dark:text-white">
            {title}
          </p>
          <p className="text-sm text-[#7D7D7D] dark:text-grey-dark-600 mt-1">
            {description}
          </p>
        </div>
      </div>
      <Button
        variant="primary"
        size="auto"
        onClick={onAction}
        className={cn(
          "h-[30px] px-3 py-[10px] gap-[10px] rounded-[6px] border text-sm font-medium flex-shrink-0",
          "border-[#3167DD] bg-[#3167DD] text-white",
          "hover:bg-[#2454c4] hover:border-[#2454c4]",
          "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
        )}
      >
        {actionLabel}
      </Button>
    </div>
  );
}

const RecoveryPhraseSettings: React.FC = () => {
  const { getMnemonic, polkadotAddress } = useWalletAuth();
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showSetPassword, setShowSetPassword] = useState(false);
  const [hasServerBlob, setHasServerBlob] = useState(false);
  // Mirror of `hasServerBlob` readable from async handlers without a stale
  // closure, so a click that lands mid-probe still falls back correctly.
  const hasServerBlobRef = useRef(false);

  // Rust answers a failed server probe with `recommendedFlow: "unknown"`
  // and `hasServerBlob: false` rather than throwing, so an offline check
  // must not be read as "no blob" — that would flip a correctly labelled
  // "Change" row to "Set". Adopt the answer only when Rust actually knows;
  // return the value now in force so callers route on it directly.
  const adoptRecoveryState = useCallback((check: RecoveryCheck): boolean => {
    if (check.recommendedFlow === "unknown") return hasServerBlobRef.current;
    hasServerBlobRef.current = check.hasServerBlob;
    setHasServerBlob(check.hasServerBlob);
    return check.hasServerBlob;
  }, []);

  const refreshRecoveryState = useCallback(async () => {
    try {
      adoptRecoveryState(await checkRecoveryState());
    } catch {
      // Network hiccup — leave previous state intact.
    }
  }, [adoptRecoveryState]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const check = await checkRecoveryState().catch(() => null);
      if (!cancelled && check) adoptRecoveryState(check);
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptRecoveryState]);

  const handleBackup = async () => {
    let result: string | null = null;
    if (polkadotAddress) {
      try {
        result = await invoke<string>("get_drive_mnemonic", {
          accountId: polkadotAddress,
        });
      } catch {
        // Drive not initialized — fall back to session store.
      }
    }
    if (!result) {
      result = await getMnemonic();
    }
    if (result) {
      setMnemonic(result);
      setShowDialog(true);
    } else {
      toast.error("Mnemonic seed not available yet. Please configure sync first.");
    }
  };

  const handleConfirm = () => {
    setShowDialog(false);
    setMnemonic(null);
  };

  // Re-probe at click time: the mount-time answer can be stale because an
  // unlock password may have been set on Hippius Console (or another device)
  // while this page was open, and "Set" would then offer to replace it. If
  // the probe fails (thrown, or answered "unknown"), fall back to the
  // last-known state rather than block the user — Rust refuses an unsafe
  // seal on its own.
  const handleUnlockPasswordAction = async () => {
    let serverBlob = hasServerBlobRef.current;
    try {
      serverBlob = adoptRecoveryState(await checkRecoveryState());
    } catch {
      // Network hiccup — keep the last-known state.
    }
    if (serverBlob) {
      setShowChangePassword(true);
    } else {
      setShowSetPassword(true);
    }
  };

  return (
    <>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div ref={ref} className="flex flex-col gap-4">
            {/* Row 1: Mnemonic Seed backup */}
            <div
              className={cn(
                "transition-all duration-500 ease-out",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
              )}
            >
              <SecurityRow
                Icon={Key}
                title="Mnemonic Seed"
                description="Your mnemonic seed is the only way to restore access to your wallet and encrypted files."
                actionLabel="Backup Mnemonic Seed"
                onAction={handleBackup}
              />
            </div>

            {/* Warning notice */}
            <div
              className={cn(
                "transition-all duration-500 ease-out delay-150",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
              )}
            >
              <SettingsWarningNotice
                title="Keep your Mnemonic key secure"
                description="If you lose your mnemonic seed, you will permanently lose access to your encrypted files. There is no way to recover it."
              />
            </div>

            {/* Row 2: Unlock password */}
            <div
              className={cn(
                "transition-all duration-500 ease-out delay-300",
                inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
              )}
            >
              <SecurityRow
                Icon={Lock}
                title="Unlock Password"
                description={
                  hasServerBlob
                    ? "Your unlock password is set. You can change it at any time."
                    : "You haven't set unlock password yet. Without it you won't be able to preview or download files on Hippius Console."
                }
                actionLabel={
                  hasServerBlob ? "Change Unlock Password" : "Set Unlock Password"
                }
                onAction={() => void handleUnlockPasswordAction()}
              />
            </div>
          </div>
        )}
      </InView>

      {mnemonic && (
        <MnemonicBackupDialog
          open={showDialog}
          mnemonic={mnemonic}
          onConfirm={handleConfirm}
          onClose={handleConfirm}
        />
      )}
      <ChangeRecoveryPasswordDialog
        open={showChangePassword}
        onOpenChange={setShowChangePassword}
      />
      <SetRecoveryPasswordDialog
        open={showSetPassword}
        onOpenChange={setShowSetPassword}
        onSuccess={refreshRecoveryState}
        onError={refreshRecoveryState}
      />
    </>
  );
};

export default RecoveryPhraseSettings;
