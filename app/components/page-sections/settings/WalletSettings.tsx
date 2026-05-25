"use client";

import React, { useMemo, useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { InView } from "react-intersection-observer";
import { Check, Copy, MoreVertical, Plus } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import {
  HardDriveUpload,
  Pencil,
  Trash,
  WalletWelcomeLogo,
} from "@/components/ui/icons";
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

/* ── address cell — renders the SS58 in full with no truncation. The
   td sizes to fit the address; any leftover width in the row is parked
   on the WALLET column instead so the Added column stays adjacent. */
function AddressCell({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success("Address copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy address");
    }
  };
  return (
    <div className="flex w-full items-center gap-2">
      <span
        // Figma spec: 1-line clamp w/ ellipsis, Geist 12 / 500 / -0.24
        // tracking, grey-dark-800 in both themes. `flex:1 0 0` lets the
        // text claim available row width and clip cleanly when the
        // column is narrower than the SS58.
        className="[flex:1_0_0] line-clamp-1 overflow-hidden text-ellipsis text-[12px] font-medium leading-[normal] tracking-[-0.24px] text-grey-dark-800 dark:text-grey-dark-800"
        title={address}
      >
        {address}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="ml-auto shrink-0 rounded p-0.5 text-grey-60 transition-colors hover:text-grey-10 dark:text-grey-dark-500 dark:hover:text-grey-light-100"
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

/* ── middle-truncate the wallet name, CSS-style. Pure char-count loses
   when the column gets wider — it'd still ellipsize even though the
   full label fits. This component instead lets the head soak up the
   cell's natural width via `truncate`, while always keeping the tail
   visible so users can still tell two long, similarly-prefixed labels
   apart. The `flex` container claims `min-w-0` so the truncate inside
   actually fires when the head overflows. */
function MiddleTruncatedName({
  name,
  tailLength = 6,
  className,
}: {
  name: string;
  tailLength?: number;
  className?: string;
}) {
  if (name.length <= tailLength + 1) {
    return <span className={className}>{name}</span>;
  }
  const head = name.slice(0, name.length - tailLength);
  const tail = name.slice(-tailLength);
  return (
    <span className={cn("flex min-w-0 items-baseline", className)}>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-nowrap">{tail}</span>
    </span>
  );
}

/* ── date helper — mirrors billing/transaction tables for consistency.
   "long" form looks like "September 02, 2025 at 07:33 pm". */
function formatDate(date: Date): string {
  return date
    .toLocaleString("en-US", {
      month: "long",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
    .replace("AM", "am")
    .replace("PM", "pm");
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
      maxWidth="max-w-[600px]"
    >
      <p className="mt-2 mb-4 text-center text-sm text-[#7d7d7d] dark:text-grey-dark-600">
        Pick a new label for this wallet. The address and access key
        are unchanged.
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
    exportBackupZip,
    setSetupStep,
  } = useLocalWallet();
  const router = useRouter();

  // The Create / Import flows live on /wallet — `setupStep` only drives
  // visible UI when `LocalWalletSetup` is mounted, and that orchestrator
  // is gated by `WalletWithLocalSupport` on the wallet route. Flipping
  // setupStep from Settings without navigating would silently set state
  // and look broken, so we always push to /wallet first.
  const startWalletFlow = (step: "create-mnemonic" | "import-wallet") => {
    setSetupStep(step);
    router.push("/wallet");
  };

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
      const bytes = await exportBackupZip(wallet.id);
      if (!bytes) {
        toast.error("Failed to export wallet");
        return;
      }
      const safeName = wallet.name.trim().replace(/\s+/g, "-") || "wallet";
      const filePath = await save({
        filters: [{ name: "Wallet backup", extensions: ["zip"] }],
        defaultPath: `hippius-wallet-${safeName}-backup.zip`,
      });
      if (!filePath) return;
      await writeFile(filePath, bytes);
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
      icon: <Check className="size-4" />,
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
        void openUrl(`https://hipstats.com/accounts/${wallet.address}`);
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
        cell: (d) => {
          const fullName = d.getValue() || "Unnamed";
          return (
            <div className="flex items-center gap-2 min-w-0" title={fullName}>
              <MiddleTruncatedName
                name={fullName}
                className="text-[12px] font-medium leading-[normal] tracking-[-0.24px] text-grey-20 dark:text-grey-dark-200"
              />
              {d.row.original.isActive ? (
                <span className="flex h-[18px] shrink-0 items-center rounded-[4px] border border-[#3167dd] bg-[#3167dd]/15 px-1.5 text-[10px] font-medium text-[#3167dd] dark:border-primary-brand-dark dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
                  Active
                </span>
              ) : null}
            </div>
          );
        },
      }),
      col.accessor("address", {
        header: "ADDRESS",
        cell: (d) => <AddressCell address={d.getValue()} />,
      }),
      col.accessor("createdAt", {
        header: "ADDED",
        enableSorting: true,
        // `createdAt` is already milliseconds from the Rust IPC — no
        // *1000 here, otherwise Date overflows to year ~58354.
        //
        // Figma spec matches the Address column: 1-line clamp w/
        // ellipsis, Geist 12 / 500 / -0.24 tracking, grey-dark-800.
        // `flex:1 0 0` keeps the date taking the column width so the
        // ellipsis kicks in when the column is squeezed.
        cell: (d) => (
          <span className="block [flex:1_0_0] line-clamp-1 overflow-hidden text-ellipsis text-[12px] font-medium leading-[normal] tracking-[-0.24px] text-grey-dark-800 dark:text-grey-dark-800">
            {formatDate(new Date(d.getValue()))}
          </span>
        ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (d) => {
          const wallet = d.row.original;
          return (
            <div className="flex items-center justify-center">
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
      <Button
        type="button"
        variant="primary"
        size="auto"
        className="h-7 gap-1 rounded-[6px] px-2.5 text-[12px] font-medium tracking-[-0.24px]"
        onClick={() => startWalletFlow("create-mnemonic")}
      >
        <Plus className="size-3" />
        Create wallet
      </Button>
      <Button
        type="button"
        variant="defaultStable"
        size="auto"
        // The card body sits on bg-grey-light-300, which is the same
        // tone as defaultStable's bg-grey-90 → the button vanishes
        // without a visible surface. White + neutral border restores
        // contrast while keeping the secondary read.
        className={cn(
          "h-7 gap-1 rounded-[6px] px-2.5 text-[12px] font-medium tracking-[-0.24px]",
          "!bg-white !text-grey-10 border border-grey-dark-100 hover:!bg-grey-light-700",
          "dark:!bg-black-600 dark:!text-grey-light-100 dark:border-black-300 dark:hover:!bg-black-500",
        )}
        onClick={() => startWalletFlow("import-wallet")}
      >
        <HardDriveUpload className="size-3" />
        Import
      </Button>
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
                // Match the Files page empty state — illustration, copy,
                // and a primary CTA so the user can act without going back
                // up to the header chips. `cardView={false}` drops the
                // outer border (we're already inside SettingsCard).
                // `children` swaps the default illustration for the
                // WalletWelcomeLogo so this surface matches the visual
                // language of the wallet welcome flow.
                <div className="p-3">
                  <NoEntriesFound
                    buttonText="Create Wallet"
                    buttonIcon={<Plus className="size-4" />}
                    onButtonClick={() => startWalletFlow("create-mnemonic")}
                    secondaryButtonText="Import"
                    secondaryButtonIcon={<HardDriveUpload className="size-4" />}
                    onSecondaryButtonClick={() =>
                      startWalletFlow("import-wallet")
                    }
                    cardView={false}
                    className="p-6 sm:p-10 rounded-[8px]"
                  >
                    <div className="flex items-center gap-5">
                      <div className="shrink-0">
                        <WalletWelcomeLogo
                          aria-hidden="true"
                          className={cn(
                            "block h-[92px] w-[120px] shrink-0",
                            "dark:[filter:brightness(1.55)_contrast(0.92)]",
                          )}
                        />
                      </div>
                      <div className="flex flex-1 min-w-0 flex-col gap-[6px]">
                        <h3 className="text-[18px] font-medium leading-6 tracking-[-0.54px] text-[#171717] dark:text-white">
                          No local wallets yet
                        </h3>
                        <p className="text-[16px] font-medium leading-6 tracking-[-0.48px] text-[#52525c] dark:text-white dark:opacity-50">
                          Create a new wallet or import an existing one to
                          start signing transactions on this device.
                        </p>
                      </div>
                    </div>
                  </NoEntriesFound>
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
                                className={cn(
                                  "bg-white dark:!bg-[#111111] !border-[#E3E3E3] dark:!border-[#313131]",
                                  // Actions column is just the 3-dot
                                  // trigger — same narrow footprint
                                  // the Drive table uses.
                                  h.column.id === "actions" &&
                                    "w-[48px] !px-1",
                                )}
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
                                  // Cap the wallet column at the original
                                  // 220px. The CSS middle-truncate inside
                                  // (MiddleTruncatedName) uses that width
                                  // for the head; very long names ellipsize
                                  // at the cell boundary while the tail
                                  // stays visible.
                                  cell.column.id === "name" &&
                                    "max-w-[220px]",
                                  cell.column.id === "actions" &&
                                    "w-[48px] !px-1",
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
