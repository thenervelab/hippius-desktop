"use client";

import React, { useMemo, useState } from "react";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import { Check, Copy, Download, ExternalLink, Plus } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { open as openShell } from "@tauri-apps/plugin-shell";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import FramedDialog from "@/components/ui/FramedDialog";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { Pencil, Trash } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import { SettingsCard } from "./SettingsCard";
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

/* ── inline icon-button used in the actions column ────────────────── */
function RowIconButton({
  onClick,
  ariaLabel,
  title,
  variant = "default",
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  ariaLabel: string;
  title: string;
  variant?: "default" | "destructive";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "flex size-7 items-center justify-center rounded-[6px] border bg-white text-grey-50 transition-colors",
        "border-grey-dark-100 hover:bg-grey-light-700 hover:text-grey-10",
        "dark:border-black-300 dark:bg-black-400 dark:text-grey-dark-600 dark:hover:bg-black-300 dark:hover:text-grey-light-100",
        variant === "destructive" &&
          "hover:border-error-70 hover:bg-error-50/10 hover:text-error-70",
      )}
    >
      {children}
    </button>
  );
}

/* ── table row for a single local wallet ──────────────────────────── */
function WalletTableRow({
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
    <tr
      className={cn(
        "border-t border-grey-dark-100 transition-colors dark:border-black-300",
        wallet.isActive
          ? "bg-[#3167dd]/[0.04] dark:bg-primary-brand-dark/[0.06]"
          : "hover:bg-grey-light-300 dark:hover:bg-black-500/40",
      )}
    >
      {/* Wallet (name + active badge) */}
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-grey-10 dark:text-grey-light-100">
            {wallet.name || "Unnamed"}
          </span>
          {wallet.isActive ? (
            <span className="flex h-[18px] items-center rounded-[4px] border border-[#3167dd] bg-[#3167dd]/15 px-1.5 text-[10px] font-medium text-[#3167dd] dark:border-primary-brand-dark dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
              Active
            </span>
          ) : null}
        </div>
      </td>

      {/* Address (mono truncated + copy) */}
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] text-grey-50 dark:text-grey-dark-600">
            {truncateAddress(wallet.address, 8, 6)}
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
        </div>
      </td>

      {/* Added (relative) */}
      <td className="px-3 py-3 align-middle">
        <span className="text-[12px] text-grey-50 dark:text-grey-dark-600">
          {formatRelativeTime(wallet.createdAt)}
        </span>
      </td>

      {/* Actions */}
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center justify-end gap-1.5">
          {!wallet.isActive ? (
            <Button
              type="button"
              variant="defaultStable"
              size="auto"
              onClick={onMakeActive}
              className="h-7 rounded-[6px] px-2.5 text-[12px] font-medium"
            >
              Set Active
            </Button>
          ) : null}
          <RowIconButton
            onClick={handleExplorer}
            ariaLabel="View on hipstats explorer"
            title="View on hipstats explorer"
          >
            <ExternalLink className="size-3.5" />
          </RowIconButton>
          <RowIconButton
            onClick={onExport}
            ariaLabel="Export wallet backup"
            title="Export wallet backup"
          >
            <Download className="size-3.5" />
          </RowIconButton>
          <RowIconButton
            onClick={onRename}
            ariaLabel="Rename wallet"
            title="Rename wallet"
          >
            <Pencil className="size-3.5" />
          </RowIconButton>
          <RowIconButton
            onClick={onDelete}
            ariaLabel="Delete wallet"
            title="Delete wallet"
            variant="destructive"
          >
            <Trash className="size-3.5" />
          </RowIconButton>
        </div>
      </td>
    </tr>
  );
}

/* ── rename dialog (one input, native FramedDialog chrome) ───────── */
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

/* ── main panel ──────────────────────────────────────────────────── */
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

  // Active wallet pinned first, then newest createdAt.
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

  // The header CTAs sit inside `SettingsCard`'s headerAction slot — same
  // visual rhythm as the "+ Add Folder" row on Sync & Storage. Plain
  // <button> here so they read as inline header chips rather than full
  // primary CTAs (the standalone primary button visually competes with
  // the table). They route into the existing setupStep flow so the
  // create/import surfaces stay the same as elsewhere in the app.
  const headerActions = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setSetupStep("create-mnemonic")}
        className="inline-flex h-7 items-center gap-1 rounded-[6px] border border-grey-dark-100 bg-white px-2.5 text-[12px] font-medium text-grey-10 transition-colors hover:bg-grey-light-700 dark:border-black-300 dark:bg-black-600 dark:text-grey-light-100 dark:hover:bg-black-500"
      >
        <Plus className="size-3" />
        Create wallet
      </button>
      <button
        type="button"
        onClick={() => setSetupStep("import-wallet")}
        className="inline-flex h-7 items-center rounded-[6px] border border-grey-dark-100 bg-white px-2.5 text-[12px] font-medium text-grey-10 transition-colors hover:bg-grey-light-700 dark:border-black-300 dark:bg-black-600 dark:text-grey-light-100 dark:hover:bg-black-500"
      >
        Import
      </button>
    </div>
  );

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div ref={ref} className="flex flex-col gap-4">
          <div
            className={cn(
              "transition-all duration-500 ease-out",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
            )}
          >
            <SettingsCard label="Wallets" headerAction={headerActions}>
              {isLoading ? (
                <div className="flex flex-col gap-2 px-4 py-4">
                  {[1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="h-10 rounded-md bg-grey-light-700 dark:bg-grey-dark-200 animate-pulse"
                    />
                  ))}
                </div>
              ) : orderedWallets.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
                  <p className="text-sm font-medium text-grey-10 dark:text-grey-light-100">
                    No local wallets yet
                  </p>
                  <p className="max-w-[360px] text-xs text-grey-50 dark:text-grey-dark-600">
                    Create a new wallet or import an existing one to start
                    signing transactions on this device.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left">
                        <th className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.5px] text-grey-50 dark:text-grey-dark-600">
                          Wallet
                        </th>
                        <th className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.5px] text-grey-50 dark:text-grey-dark-600">
                          Address
                        </th>
                        <th className="px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.5px] text-grey-50 dark:text-grey-dark-600">
                          Added
                        </th>
                        <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-[0.5px] text-grey-50 dark:text-grey-dark-600">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedWallets.map((wallet) => (
                        <WalletTableRow
                          key={wallet.id}
                          wallet={wallet}
                          onMakeActive={() => handleSetActive(wallet)}
                          onExport={() => handleExport(wallet)}
                          onRename={() => setWalletToRename(wallet)}
                          onDelete={() => setWalletToDelete(wallet)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SettingsCard>
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
                  from this device. Make sure you have a backup of its
                  access key — without it the wallet cannot be recovered.
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
      )}
    </InView>
  );
};

export default WalletSettings;
