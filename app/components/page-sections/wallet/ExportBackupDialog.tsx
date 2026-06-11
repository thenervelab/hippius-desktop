"use client";

import React, { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Lock } from "@/components/ui/icons";
import { isNotReady } from "@/lib/utils/dispatchTauriError";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { WalletDialogShell } from "./shared/WalletDesign";
import WalletPasswordField from "./shared/WalletPasswordField";

export interface ExportBackupTarget {
  id: number;
  name: string;
}

/**
 * Password-gated wallet-backup export.
 *
 * The backend (`local_wallet_export_backup` / `_zip`) now REQUIRES the wallet
 * password (audit R-07) — the encrypted backup is offline-crackable, so it
 * can't be handed out on a bare IPC call anymore. This dialog collects the
 * password, runs the export, and writes the encrypted `.zip` to a user-chosen
 * path. Render it from the wallet list/settings and pass the wallet to export
 * (or `null` to keep it closed).
 */
export default function ExportBackupDialog({
  wallet,
  onClose,
}: {
  wallet: ExportBackupTarget | null;
  onClose: () => void;
}) {
  const { exportBackupZip } = useLocalWallet();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = wallet !== null;

  // Clear transient state each time the dialog (re)opens for a wallet.
  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
      setBusy(false);
    }
  }, [open, wallet?.id]);

  const close = () => {
    if (!busy) {
      // Don't let the typed password outlive the dialog — it stays mounted
      // after close, so React state would otherwise hold it indefinitely.
      setPassword("");
      onClose();
    }
  };

  const handleExport = async () => {
    if (!wallet || busy) return;
    if (!password) {
      setError("Enter your wallet password");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = await exportBackupZip(wallet.id, password);
      const safeName = wallet.name.trim().replace(/\s+/g, "-") || "wallet";
      const filePath = await save({
        filters: [{ name: "Wallet backup", extensions: ["zip"] }],
        defaultPath: `hippius-wallet-${safeName}-backup.zip`,
      });
      // User cancelled the OS save dialog — keep this dialog open.
      if (!filePath) return;
      await writeFile(filePath, bytes);
      toast.success("Wallet backup saved");
      setPassword("");
      onClose();
    } catch (e) {
      console.error("[ExportBackupDialog] export failed:", e);
      // A rate-limit lockout must show its retry-after text — telling a
      // locked-out user their CORRECT password is wrong keeps them
      // retrying blind (and the limiter rejects before verifying, so
      // those retries never succeed).
      if (isNotReady(e, "RATE_LIMITED")) {
        setError(
          (e as { message?: string }).message ??
            "Too many failed attempts. Please wait before trying again.",
        );
      } else {
        setError("Incorrect password, or the export failed. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <WalletDialogShell
      open={open}
      onClose={close}
      title="Export wallet backup"
      description="Enter your wallet password to export an encrypted backup."
      icon={<Lock className="size-4 text-white" />}
      maxWidth="max-w-[480px]"
      footer={
        <Button
          type="button"
          variant="primary"
          className="h-[40px] w-full rounded-[6px] px-4 text-[14px] font-medium tracking-[-0.28px]"
          onClick={handleExport}
          disabled={busy || !password}
        >
          {busy ? "Exporting…" : "Export backup"}
        </Button>
      }
    >
      <WalletPasswordField
        value={password}
        onChange={(v) => {
          setPassword(v);
          if (error) setError(null);
        }}
        error={error}
        disabled={busy}
        autoFocusOnOpen={open}
        onSubmit={handleExport}
      />
    </WalletDialogShell>
  );
}
