"use client";

import React, { useMemo, useState } from "react";
import { toast } from "sonner";
import { InView } from "react-intersection-observer";
import { Check, Copy, MoreVertical, Plus } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { open as openShell } from "@tauri-apps/plugin-shell";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui";
import FramedDialog from "@/components/ui/FramedDialog";
import ConfirmationDialog from "@/components/ConfirmationDialog";
import { Pencil, Trash } from "@/components/ui/icons";
import { Download, ExternalLink } from "lucide-react";
import TableActionMenu, {
  type ActionItem,
} from "@/components/ui/alt-table/TableActionMenu";
import {
  Table,
  TableWrapper,
  THead,
  TBody,
  Tr,
  Th,
  Td,
} from "@/components/ui/table";
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

/* ── address cell — mono truncated + copy ─────────────────────────── */
function AddressCell({ fullAddress }: { fullAddress: string }) {
  const { truncateAddress } = useLocalWallet();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(fullAddress);
      setCopied(true);
      toast.success("Address copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy address");
    }
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="font-mono text-[12px] text-grey-20 dark:text-grey-dark-200 truncate">
        {truncateAddress(fullAddress, 8, 6)}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded p-0.5 text-grey-60 transition-colors hover:text-grey-10 dark:text-grey-dark-500 dark:hover:text-grey-light-100"
        aria-label="Copy address"
        title="Copy full address"
      >
        {copied ? (
          <Check className="size-3.5 text-success-50" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}

/* ── rename dialog ───────────────────────────────────────────────── */
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
const col = createColumnHelper<LocalWallet>();

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
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);

  // Active first, then newest createdAt.
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

  /* ── action items for both the 3-dot menu and the right-click
        context menu (both surfaces share the same callbacks). */
  const buildMenuItems = (wallet: LocalWallet): ActionItem[] => [
    {
      icon: (
        <span className="inline-flex size-4 items-center justify-center rounded-full bg-success-50/15 text-success-50">
          <span className="size-1.5 rounded-full bg-success-50" />
        </span>
      ),
      itemTitle: wallet.isActive ? "Active wallet" : "Set as active",
      disabled: wallet.isActive,
      onItemClick: () => {
        setOpenMenuId(null);
        void handleSetActive(wallet);
      },
    },
    {
      icon: <Copy className="size-4" />,
      itemTitle: "Copy address",
      onItemClick: async () => {
        setOpenMenuId(null);
        try {
          await navigator.clipboard.writeText(wallet.address);
          toast.success("Address copied");
        } catch {
          toast.error("Failed to copy address");
        }
      },
    },
    {
      icon: <ExternalLink className="size-4" />,
      itemTitle: "View on Hipstats",
      onItemClick: () => {
        setOpenMenuId(null);
        void openShell(`https://hipstats.com/accounts/${wallet.address}`);
      },
    },
    {
      icon: <Download className="size-4" />,
      itemTitle: "Export backup",
      onItemClick: () => {
        setOpenMenuId(null);
        void handleExport(wallet);
      },
    },
    {
      icon: <Pencil className="size-4" />,
      itemTitle: "Rename",
      onItemClick: () => {
        setOpenMenuId(null);
        setWalletToRename(wallet);
      },
    },
    {
      icon: <Trash className="size-4" />,
      itemTitle: "Delete",
      variant: "destructive",
      onItemClick: () => {
        setOpenMenuId(null);
        setWalletToDelete(wallet);
      },
    },
  ];

  /* ── TanStack columns ─────────────────────────────────────────── */
  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "WALLET",
        cell: (d) => (
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate font-medium text-grey-20 dark:text-grey-dark-200">
              {d.getValue() || "Unnamed"}
            </span>
            {d.row.original.isActive ? (
              <span className="flex h-[18px] shrink-0 items-center rounded-[4px] border border-[#3167dd] bg-[#3167dd]/15 px-1.5 text-[10px] font-medium text-[#3167dd] dark:border-primary-brand-dark dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
                Active
              </span>
            ) : null}
          </div>
        ),
      }),
      col.accessor("address", {
        header: "ADDRESS",
        cell: (d) => <AddressCell fullAddress={d.getValue()} />,
      }),
      col.accessor("createdAt", {
        header: "ADDED",
        enableSorting: true,
        cell: (d) => (
          <span className="font-medium text-grey-dark-800 dark:text-grey-dark-800">
            {formatRelativeTime(d.getValue())}
          </span>
        ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (d) => {
          const wallet = d.row.original;
          return (
            <div className="flex justify-end">
              <TableActionMenu
                dropdownTitle=""
                items={buildMenuItems(wallet)}
                open={openMenuId === wallet.id}
                onOpenChange={(o) =>
                  setOpenMenuId(o ? wallet.id : null)
                }
              >
                <button
                  type="button"
                  className="flex size-7 items-center justify-center rounded-[6px] text-grey-60 transition-colors hover:bg-grey-light-700 hover:text-grey-10 dark:text-grey-dark-500 dark:hover:bg-black-400 dark:hover:text-grey-light-100"
                  aria-label="Wallet actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreVertical className="size-4" />
                </button>
              </TableActionMenu>
            </div>
          );
        },
      }),
    ],
    // buildMenuItems closes over current handlers; safe to omit from deps
    // since they don't change references on every render that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openMenuId, busyWalletId],
  );

  const table = useReactTable({
    columns,
    data: orderedWallets,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

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
                <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
                  <div className="overflow-x-auto custom-scrollbar-thin">
                    <Table className="min-w-[560px]">
                      <THead>
                        {table.getHeaderGroups().map((hg) => (
                          <Tr key={hg.id}>
                            {hg.headers.map((h) => (
                              <Th
                                key={h.id}
                                header={h}
                                className="bg-white dark:!bg-[#111111] !border-[#E3E3E3] dark:!border-[#313131]"
                              />
                            ))}
                          </Tr>
                        ))}
                      </THead>
                      <TBody>
                        {table.getRowModel().rows.map((row) => (
                          <Tr
                            key={row.id}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setOpenMenuId(row.original.id);
                            }}
                          >
                            {row.getVisibleCells().map((cell) => (
                              <Td
                                key={cell.id}
                                cell={cell}
                                className={cn(
                                  "!border-[#E3E3E3] dark:!border-[#313131]",
                                  row.index % 2 === 0
                                    ? "bg-[#fbfbfb] dark:bg-[#161616]"
                                    : "bg-[#f5f5f5] dark:bg-[#1e1e1e]",
                                )}
                              />
                            ))}
                          </Tr>
                        ))}
                      </TBody>
                    </Table>
                  </div>
                </TableWrapper>
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
