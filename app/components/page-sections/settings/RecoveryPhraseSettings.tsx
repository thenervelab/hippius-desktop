"use client";

import React, { useCallback, useEffect, useState } from "react";
import SectionHeader from "./SectionHeader";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { MnemonicBackupDialog } from "./MnemonicBackupDialog";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { InView } from "react-intersection-observer";
import ChangeRecoveryPasswordDialog from "@/components/recovery/ChangeRecoveryPasswordDialog";
import SetRecoveryPasswordDialog from "@/components/recovery/SetRecoveryPasswordDialog";
import { checkRecoveryState } from "@/app/lib/utils/recovery";

const RecoveryPhraseSettings: React.FC = () => {
  const { getMnemonic, polkadotAddress } = useWalletAuth();
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showSetPassword, setShowSetPassword] = useState(false);
  const [hasServerBlob, setHasServerBlob] = useState(false);

  const refreshRecoveryState = useCallback(async () => {
    try {
      const check = await checkRecoveryState();
      setHasServerBlob(check.hasServerBlob);
    } catch {
      // Network hiccup: hide the button rather than show a broken one.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const check = await checkRecoveryState().catch(() => null);
      if (!cancelled && check) setHasServerBlob(check.hasServerBlob);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBackup = async () => {
    // Try to get mnemonic from the HCFS Drive first (works for both mnemonic and OAuth users),
    // then fall back to session store.
    let result: string | null = null;
    if (polkadotAddress) {
      try {
        result = await invoke<string>("get_drive_mnemonic", { accountId: polkadotAddress });
      } catch {
        // Drive not initialized or not available — fall back to session store
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

  return (
    <>
      {/* Card 1: Mnemonic Seed Backup */}
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex flex-col w-full border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover"
          >
            <RevealTextLine
              rotate
              reveal={inView}
              parentClassName="w-full"
              className="delay-300 w-full"
            >
              <SectionHeader
                Icon={Icons.Key}
                title="Mnemonic Seed"
                subtitle="Your mnemonic seed is the only way to restore access to your account and encrypted files."
              />
            </RevealTextLine>
            <RevealTextLine
              rotate
              reveal={inView}
              parentClassName="w-full"
              className="delay-500 w-full"
            >
              <div className="flex justify-between items-center p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full">
                <p className="text-sm text-grey-60">
                  Back up your mnemonic seed and store it somewhere safe. Never share it with anyone.
                </p>
                <CardButton
                  className="max-w-[13.75rem] h-10 ml-4 shrink-0"
                  variant="primary"
                  onClick={handleBackup}
                >
                  <span className="text-base leading-4 font-medium">
                    Backup Mnemonic Seed
                  </span>
                </CardButton>
              </div>
            </RevealTextLine>

            {/* Security Warning */}
            <RevealTextLine
              rotate
              reveal={inView}
              parentClassName="w-full"
              className="delay-700 w-full"
            >
              <div className="bg-warning-90/20 border border-warning-80 rounded-lg p-3 mt-4">
                <div className="flex gap-2">
                  <div className="mt-0.5">
                    <div className="size-5 rounded-full bg-warning-50/20 flex items-center justify-center">
                      <span className="text-warning-50 text-sm font-bold">!</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-warning-10">
                      Keep your mnemonic seed safe
                    </p>
                    <p className="text-sm text-warning-30">
                      If you lose your mnemonic seed, you will permanently lose access to your encrypted files. There is no way to recover it.
                    </p>
                  </div>
                </div>
              </div>
            </RevealTextLine>
          </div>
        )}
      </InView>

      {/* Card 2: Unlock Password */}
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex flex-col w-full border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover"
          >
            <RevealTextLine
              rotate
              reveal={inView}
              parentClassName="w-full"
              className="delay-300 w-full"
            >
              <SectionHeader
                Icon={Icons.ShieldSecurity}
                title="Unlock Password"
                subtitle="Access your encrypted files on other devices and Hippius Console."
              />
            </RevealTextLine>
            {hasServerBlob ? (
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-500 w-full"
              >
                <div className="flex justify-between items-center p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full">
                  <p className="text-sm text-grey-60">
                    Your unlock password is set. You can change it at any time.
                  </p>
                  <CardButton
                    className="max-w-[13.75rem] h-10 ml-4 shrink-0"
                    variant="primary"
                    onClick={() => setShowChangePassword(true)}
                  >
                    <span className="text-base leading-4 font-medium">
                      Change Unlock Password
                    </span>
                  </CardButton>
                </div>
              </RevealTextLine>
            ) : (
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-500 w-full"
              >
                <div className="flex justify-between items-center p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full">
                  <p className="text-sm text-grey-60">
                    You haven&apos;t set an unlock password yet. Without it, you won&apos;t be able to access your files on other devices or Hippius Console.
                  </p>
                  <CardButton
                    className="max-w-[13.75rem] h-10 ml-4 shrink-0"
                    variant="primary"
                    onClick={() => setShowSetPassword(true)}
                  >
                    <span className="text-base leading-4 font-medium">
                      Set Unlock Password
                    </span>
                  </CardButton>
                </div>
              </RevealTextLine>
            )}
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
      />
    </>
  );
};

export default RecoveryPhraseSettings;
