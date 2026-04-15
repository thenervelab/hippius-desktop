"use client";

import React, { useEffect, useState } from "react";
import SectionHeader from "./SectionHeader";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { MnemonicBackupDialog } from "./MnemonicBackupDialog";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { InView } from "react-intersection-observer";
import ChangeRecoveryPasswordDialog from "@/components/recovery/ChangeRecoveryPasswordDialog";
import { checkRecoveryState } from "@/app/lib/utils/recovery";

const RecoveryPhraseSettings: React.FC = () => {
  const { getMnemonic, polkadotAddress } = useWalletAuth();
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [hasServerBlob, setHasServerBlob] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const check = await checkRecoveryState();
        if (!cancelled) setHasServerBlob(check.hasServerBlob);
      } catch {
        // Network hiccup: hide the button rather than show a broken one.
      }
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
      toast.error("Recovery phrase not available yet. Please configure sync first.");
    }
  };

  const handleConfirm = () => {
    setShowDialog(false);
    setMnemonic(null);
  };

  return (
    <>
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
                Icon={Icons.KeySquare}
                title="Recovery Phrase"
                subtitle="Back up your recovery phrase to ensure you can always access your encrypted files. Without it, your data cannot be recovered."
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
                  Your recovery phrase is the only way to restore access to your encrypted sync folder. Keep it safe and never share it.
                </p>
                <CardButton
                  className="max-w-[13.75rem] h-10 ml-4 shrink-0"
                  variant="primary"
                  onClick={handleBackup}
                >
                  <span className="text-base leading-4 font-medium">
                    Backup Recovery Phrase
                  </span>
                </CardButton>
              </div>
            </RevealTextLine>
            {hasServerBlob && (
              <RevealTextLine
                rotate
                reveal={inView}
                parentClassName="w-full"
                className="delay-700 w-full"
              >
                <div className="flex justify-between items-center p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full">
                  <p className="text-sm text-grey-60">
                    Change the password that protects your encrypted sync folder and recovery data. This password cannot be reset — choose one you can remember.
                  </p>
                  <CardButton
                    className="max-w-[13.75rem] h-10 ml-4 shrink-0"
                    variant="primary"
                    onClick={() => setShowChangePassword(true)}
                  >
                    <span className="text-base leading-4 font-medium">
                      Change Password
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
    </>
  );
};

export default RecoveryPhraseSettings;
