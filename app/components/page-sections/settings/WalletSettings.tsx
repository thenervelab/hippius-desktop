"use client";

import React, { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Download, ExternalLink, Plus, X } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { open as openShell } from "@tauri-apps/plugin-shell";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import FramedDialog from "@/components/ui/FramedDialog";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { Pencil, Trash, Wallet as WalletIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import SectionHeader from "./SectionHeader";
import {
  useLocalWallet,
  type LocalWallet,
} from "@/app/contexts/LocalWalletContext";

/* ── relative-time helper ─────────────────────────────────────────── */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp * 1000;
  if (diffMs < 60_000) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon} mo ago`;
  const diffYr = Math.floor(diffMon / 12);
  return `${diffYr} yr ago`;
}

/* ── per-wallet row ──────────────────────────────────────────────── */
function WalletManagementRow({
  wallet,
  onMakeActive,
  onExport,
  onRename,
  onDelete,
}: {
  wallet: LocalWallet;
  onMakeActive: () => void;
  onExport: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { truncateAddress } = useLocalWallet();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      toast.success("Address copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  const handleExplorer = (e: React.MouseEvent) => {
    e.stopPropagation();
    void openShell(`https://hipstats.com/accounts/${wallet.address}`);
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 rounded-[8px] border px-4 py-3 transition-colors",
        wallet.isActive
          ? "border-[#3167dd] bg-[#3167dd]/[0.06] dark:border-primary-brand-dark dark:bg-primary-brand-dark/[0.06]"
          : "border-grey-dark-100 bg-white dark:border-black-300 dark:bg-black-600",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[8px]",
            wallet.isActive
              ? "bg-[#3167dd]/15 text-[#3167dd] dark:bg-primary-brand-dark/20 dark:text-primary-brand-dark"
              : "bg-grey-light-700 text-grey-50 dark:bg-black-400 dark:text-grey-dark-600",
          )}
        >
          <WalletIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-grey-10 dark:text-grey-light-100">
              {wallet.name || "Unnamed"}
            </span>
            {wallet.isActive ? (
              <span className="flex h-[18px] items-center rounded-[4px] border border-[#3167dd] bg-[#3167dd]/15 px-1.5 text-[10px] font-medium text-[#3167dd] dark:border-primary-brand-dark dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
                Active
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] text-grey-50 dark:text-grey-dark-600">
              {truncateAddress(wallet.address, 10, 8)}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded p-0.5 text-grey-50 hover:bg-grey-light-700 hover:text-grey-10 dark:text-grey-dark-600 dark:hover:bg-black-400 dark:hover:text-grey-light-100"
              aria-label="Copy address"
            >
              {copied ? (
                <Check className="size-3 text-success-50" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
            <span className="text-[11px] text-grey-50 dark:text-grey-dark-600">
              · Added {formatRelativeTime(wallet.createdAt)}
            </span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {!wallet.isActive ? (
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={onMakeActive}
            className="h-[28px] rounded-[6px] px-2.5 text-[12px] font-medium"
          >
            Set Active
          </Button>
        ) : null}
        <button
          type="button"
          onClick={handleExplorer}
          className="flex size-7 items-center justify-center rounded-[6px] border border-grey-dark-100 bg-white text-grey-50 transition-colors hover:bg-grey-light-700 hover:text-grey-10 dark:border-black-300 dark:bg-black-400 dark:text-grey-dark-600 dark:hover:bg-black-300 dark:hover:text-grey-light-100"
          aria-label="View on hipstats explorer"
          title="View on hipstats explorer"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onExport}
          className="flex size-7 items-center justify-center rounded-[6px] border border-grey-dark-100 bg-white text-grey-50 transition-colors hover:bg-grey-light-700 hover:text-grey-10 dark:border-black-300 dark:bg-black-400 dark:text-grey-dark-600 dark:hover:bg-black-300 dark:hover:text-grey-light-100"
          aria-label="Export wallet backup"
          title="Export wallet backup"
        >
          <Download className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onRename}
          className="flex size-7 items-center justify-center rounded-[6px] border border-grey-dark-100 bg-white text-grey-50 transition-colors hover:bg-grey-light-700 hover:text-grey-10 dark:border-black-300 dark:bg-black-400 dark:text-grey-dark-600 dark:hover:bg-black-300 dark:hover:text-grey-light-100"
          aria-label="Rename wallet"
          title="Rename wallet"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="flex size-7 items-center justify-center rounded-[6px] border border-grey-dark-100 bg-white text-grey-50 transition-colors hover:border-error-70 hover:bg-error-50/10 hover:text-error-70 dark:border-black-300 dark:bg-black-400 dark:text-grey-dark-600"
          aria-label="Delete wallet"
          title="Delete wallet"
        >
          <Trash className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/* ── rename dialog (small FramedDialog with one input) ──────────── */
function RenameWalletDialog({
  open,
  initialName,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  // Keep the input synced when the dialog is re-opened for a different wallet.
  React.useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialName.trim();

  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      title="Rename Wallet"
      icon={<Pencil className="size-4 text-white" />}
      maxWidth="max-w-[480px]"
    >
      <p className="-mt-4 mb-4 text-center text-sm text-[#7d7d7d] dark:text-grey-dark-600">
        Pick a new label for this wallet. The address and recovery
        material are unchanged.
      </p>
      <div className="flex flex-col gap-2">
        <label
          htmlFor="rename-wallet-input"
          className="text-[13px] font-medium text-grey-dark-600"
        >
          Wallet name
        </label>
        <Input
          id="rename-wallet-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Wallet name"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              onSubmit(trimmed);
            }
          }}
        />
      </div>
      <div className="mt-6 flex gap-4">
        <Button
          type="button"
          variant="defaultStable"
          className="h-[40px] flex-1 rounded-[6px] px-4 text-[13px] font-medium"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          className="h-[40px] flex-1 rounded-[6px] px-4 text-[14px] font-medium"
          onClick={() => onSubmit(trimmed)}
          disabled={!canSubmit}
        >
          Save
        </Button>
      </div>
    </FramedDialog>
  );
}

/* ── main settings panel ──────────────────────────────────────────── */
const WalletSettings: React.FC = () => {
  const {
    wallets,
    isLoading,
    switchWallet,
    renameWallet,
    removeWallet,
    exportBackup,
    setSetupStep,
  } = useLocalWallet();

  const [walletToDelete, setWalletToDelete] = useState<LocalWallet | null>(
    null,
  );
  const [walletToRename, setWalletToRename] = useState<LocalWallet | null>(
    null,
  );
  const [busyWalletId, setBusyWalletId] = useState<number | null>(null);

  // Active wallet first so it's the easiest to scan, then by createdAt
  // descending (newest first) for everything else.
  const orderedWallets = useMemo(() => {
    return [...wallets].sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return b.createdAt - a.createdAt;
    });
  }, [wallets]);

  const handleSetActive = async (wallet: LocalWallet) => {
    if (wallet.isActive) return;
    setBusyWalletId(wallet.id);
    try {
      const ok = await switchWallet(wallet.id);
      if (ok) toast.success(`Switched to ${wallet.name}`);
      else toast.error("Failed to switch wallet");
    } finally {
      setBusyWalletId(null);
    }
  };

  const handleExport = async (wallet: LocalWallet) => {
    try {
      const backup = await exportBackup(wallet.id);
      if (!backup) {
        toast.error("Failed to export wallet");
        return;
      }
      const safeName = wallet.name.trim().replace(/\s+/g, "-") || "wallet";
      const filePath = await save({
        filters: [{ name: "Wallet backup", extensions: ["json"] }],
        defaultPath: `hippius-wallet-${safeName}-backup.json`,
      });
      if (!filePath) return;
      const payload = { version: 2, ...backup };
      await writeTextFile(filePath, JSON.stringify(payload, null, 2));
      toast.success("Wallet backup saved");
    } catch (e) {
      console.error("[WalletSettings] export failed:", e);
      toast.error("Failed to export wallet");
    }
  };

  const handleRenameSubmit = async (name: string) => {
    if (!walletToRename) return;
    const ok = await renameWallet(walletToRename.id, name);
    if (ok) {
      toast.success("Wallet renamed");
      setWalletToRename(null);
    } else {
      toast.error("Failed to rename wallet");
    }
  };

  const handleDeleteConfirm = async () => {
    if (!walletToDelete) return;
    setBusyWalletId(walletToDelete.id);
    try {
      const ok = await removeWallet(walletToDelete.id);
      if (ok) {
        toast.success(`${walletToDelete.name} removed`);
        setWalletToDelete(null);
      } else {
        toast.error("Failed to remove wallet");
      }
    } finally {
      setBusyWalletId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 rounded-lg bg-white p-4 shadow-menu dark:bg-black-600">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeader
            Icon={WalletIcon}
            title="Wallets"
            subtitle="Switch between local wallets, rename them, back them up, or remove ones you no longer use."
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="primary"
              size="auto"
              className="h-[34px] rounded-[6px] px-3 text-[13px] font-medium"
              onClick={() => setSetupStep("create-mnemonic")}
            >
              <Plus className="mr-1.5 size-3.5" /> Create wallet
            </Button>
            <Button
              type="button"
              variant="defaultStable"
              size="auto"
              className="h-[34px] rounded-[6px] px-3 text-[13px] font-medium"
              onClick={() => setSetupStep("import-wallet")}
            >
              Import wallet
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {isLoading ? (
            <p className="py-6 text-center text-sm text-grey-50 dark:text-grey-dark-600">
              Loading wallets…
            </p>
          ) : orderedWallets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[8px] border border-dashed border-grey-dark-100 bg-grey-light-300 px-4 py-8 text-center dark:border-black-300 dark:bg-black-primary-bg">
              <WalletIcon className="size-6 text-grey-50 dark:text-grey-dark-600" />
              <p className="text-sm font-medium text-grey-10 dark:text-grey-light-100">
                No local wallets yet
              </p>
              <p className="max-w-[320px] text-xs text-grey-50 dark:text-grey-dark-600">
                Create a new wallet or import an existing one to start
                signing transactions on this device.
              </p>
            </div>
          ) : (
            orderedWallets.map((wallet) => (
              <WalletManagementRow
                key={wallet.id}
                wallet={wallet}
                onMakeActive={() => handleSetActive(wallet)}
                onExport={() => handleExport(wallet)}
                onRename={() => setWalletToRename(wallet)}
                onDelete={() => setWalletToDelete(wallet)}
              />
            ))
          )}
        </div>
      </div>

      <RenameWalletDialog
        open={walletToRename !== null}
        initialName={walletToRename?.name ?? ""}
        onClose={() => setWalletToRename(null)}
        onSubmit={handleRenameSubmit}
      />

      <ConfirmationDialog
        open={walletToDelete !== null}
        heading="Delete Wallet"
        text={
          walletToDelete ? (
            <>
              You are about to remove{" "}
              <span className="font-semibold text-grey-10 dark:text-grey-light-100">
                {walletToDelete.name}
              </span>{" "}
              from this device. Make sure you have a backup of its access
              key — without it the wallet cannot be recovered.
            </>
          ) : (
            ""
          )
        }
        button="Delete"
        icon={<Trash className="size-4 text-white" />}
        iconBgColor="bg-[#fc7d73]"
        borderClassName="bg-[#fc7d73]"
        confirmVariant="destructive"
        disableButton={busyWalletId === walletToDelete?.id}
        onConfirm={() => void handleDeleteConfirm()}
        onBack={() => setWalletToDelete(null)}
        onClose={() => setWalletToDelete(null)}
      />
    </div>
  );
};

export default WalletSettings;
