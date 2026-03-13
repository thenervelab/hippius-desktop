"use client";

import React, { useState } from "react";
import SectionHeader from "./SectionHeader";
import { CardButton, Icons } from "@/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { MnemonicBackupDialog } from "./MnemonicBackupDialog";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";

const RecoveryPhraseSettings: React.FC = () => {
  const { getMnemonic, polkadotAddress } = useWalletAuth();
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);

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
      <div className="flex flex-col w-full border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover">
        <SectionHeader
          Icon={Icons.KeySquare}
          title="Recovery Phrase"
          subtitle="Back up your recovery phrase to ensure you can always access your encrypted files. Without it, your data cannot be recovered."
        />
        <div className="flex justify-between items-center p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full">
          <p className="text-sm text-grey-60">
            Your recovery phrase is the only way to restore access to your encrypted sync folder. Keep it safe and never share it.
          </p>
          <CardButton
            className="max-w-[220px] h-10 ml-4 shrink-0"
            variant="primary"
            onClick={handleBackup}
          >
            <span className="text-base leading-4 font-medium">
              Backup Recovery Phrase
            </span>
          </CardButton>
        </div>
      </div>

      {mnemonic && (
        <MnemonicBackupDialog
          open={showDialog}
          mnemonic={mnemonic}
          onConfirm={handleConfirm}
          onClose={handleConfirm}
        />
      )}
    </>
  );
};

export default RecoveryPhraseSettings;
