// "My Shares" page — lists every active share-token this device's
// keystore knows about for the logged-in account, with Copy, Reshare,
// and Revoke affordances per row.
//
// Layout: two TanStack tables — Active Shares (top) and History
// (bottom) — rendered through the same `alt-table` primitives My
// Drive uses. We reuse `useReactTable` + `createColumnHelper` so the
// headers (sort arrows, uppercase, alignment, borders) come out
// identical to /files without restyling them by hand.
//
// Refresh strategy: TanStack Query with a 30-second `refetchInterval`
// so the list stays in step with server-side TTL expiry without the
// user reloading. Page is gated by `shareFeatureEnabledAtom` — if the
// connected hcfs-server doesn't advertise `shares: true`, we render a
// short "feature unavailable" panel instead of an empty list.

"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useAtomValue } from "jotai";
import { Check, Copy as CopyIcon, Loader2, MoreVertical, RefreshCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { AbstractIconWrapper, Icons } from "@/components/ui";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import { Button } from "@/components/ui/button";
import * as TableModule from "@/components/ui/alt-table";
import TableActionMenu, { type ActionItem } from "@/app/components/ui/alt-table/TableActionMenu";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { listShares, reshare, revokeShare, type ShareSummary } from "@/app/lib/tauri/shares";
import {
  clearShareHistory,
  listShareHistory,
  removeShareHistory,
  type HistoryEndReason,
  type ShareHistoryEntry,
} from "@/app/lib/tauri/shareHistory";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { formatBytes } from "@/lib/utils/formatBytes";
import { formatRelative } from "@/app/lib/utils/timeRelative";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/lib/utils";
import { pickHistoryRowDisplay, pickShareRowDisplay } from "./shareRowDisplay";

const SHARES_QUERY_KEY = "shares-list";
const HISTORY_QUERY_KEY = "shares-history-list";
const REFRESH_INTERVAL_MS = 30_000;

// Column width percentages. Active Shares has six columns (Name | Link |
// Size | Created | Expires | actions); History keeps the original five
// (Name | Size | Created | Ended | actions). The `link` key is only
// used by the active table — History rows have no live URL to copy.
const COLUMN_WIDTHS: Record<string, number> = {
  name: 33,
  link: 30,
  size: 10,
  created: 12,
  endsAt: 11,
  actions: 4,
};

const HISTORY_COLUMN_WIDTHS: Record<string, number> = {
  name: 42,
  size: 14,
  created: 18,
  endsAt: 22,
  actions: 4,
};

export default function MySharesPage() {
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const queryClient = useQueryClient();
  const router = useRouter();
  // Revoke is destructive and irreversible — the row click queues a token
  // here; `confirmRevoke` only fires after the user accepts in the
  // `ConfirmDialog`. Keeping the token (not a boolean) lets us reuse the
  // same dialog for any row without an extra "which token?" piece of state.
  const [tokenPendingRevoke, setTokenPendingRevoke] = React.useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  // Token whose reshare IPC is currently in flight. Used to replace
  // that row's 3-dot button with a spinner so the user knows we are
  // working, and to prevent a second reshare click on the same row.
  const [resharingToken, setResharingToken] = React.useState<string | null>(null);
  // `clearAllOpen` drives the "Clear all history" confirmation dialog.
  // Single boolean (not a token carrier) because the action is global —
  // there is nothing per-row to remember while the dialog is open.
  const [clearAllOpen, setClearAllOpen] = React.useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: [SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listShares(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  // History is a separate query because the lists rotate at different
  // cadences (active list churns on revoke/reshare, history grows
  // monotonically until the user clears it). Same refetch interval so
  // the diff path on the Rust side can keep both surfaces in step
  // without the FE doing any cross-list bookkeeping.
  const { data: historyData } = useQuery({
    queryKey: [HISTORY_QUERY_KEY, polkadotAddress],
    queryFn: () => listShareHistory(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    refetchInterval: REFRESH_INTERVAL_MS,
  });

  const queueRevoke = (token: string) => setTokenPendingRevoke(token);

  const confirmRevoke = async () => {
    if (!tokenPendingRevoke) return;
    setRevokeBusy(true);
    try {
      await revokeShare(tokenPendingRevoke);
      toast.success("Share link revoked");
      // Refresh both lists immediately rather than waiting for the 30s
      // tick — Rust records a `RevokedHere` history entry on success, so
      // the new row would otherwise pop in late.
      queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY, polkadotAddress] });
      queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not revoke share link: ${errorMessage(err)}`);
    } finally {
      setRevokeBusy(false);
      setTokenPendingRevoke(null);
    }
  };

  const onRemoveHistory = async (token: string) => {
    try {
      await removeShareHistory(token);
      // No success toast — the row disappearing is its own confirmation.
      queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not remove from history: ${errorMessage(err)}`);
    }
  };

  const onReshare = async (token: string) => {
    setResharingToken(token);
    try {
      const link = await reshare(token);
      // Auto-copy mirrors the create-share modal: the user pressed
      // Reshare *to share again*, so the new URL on the clipboard is
      // the obvious next step.
      try {
        await navigator.clipboard.writeText(link.shareUrl);
        toast.success("New link copied to clipboard");
      } catch {
        // Clipboard rejection (Safari focus rules etc.) shouldn't
        // hide the success — the row will repaint with the new URL.
        toast.success("Link reshared with a fresh expiry");
      }
      queryClient.invalidateQueries({ queryKey: [SHARES_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not reshare: ${errorMessage(err)}`);
    } finally {
      setResharingToken(null);
    }
  };

  const onCopy = async (url: string | null) => {
    if (!url) {
      toast.error("This share's key is not on this device — copy it from the device that created it.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch (err) {
      toast.error(`Could not copy link: ${errorMessage(err)}`);
    }
  };

  return (
    <DashboardTitleWrapper mainText="Shared Links">
      {/* `← Back` button sits tight to the page header, mirroring the
          folder-page convention (`files-folder/index.tsx`). The shares
          page only has one place to go back to (Drive), so a single
          back button is clearer than a two-segment breadcrumb. */}
      <button
        onClick={() => router.push("/files")}
        // `focus:outline-none` kills the default ring that browsers
        // apply to a button when focus persists after a click-driven
        // navigation. `focus-visible:ring-*` keeps the affordance for
        // keyboard users so we don't regress a11y. Same approach used
        // by the row buttons in `RowButton`/files-table.
        className="mt-3 flex items-center gap-2 font-semibold text-lg text-grey-10 hover:text-primary-50 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-2"
      >
        <Icons.ArrowLeft className="size-5" />
        Back
      </button>

      <div className="mt-3 flex flex-col gap-6">
        {!shareEnabled && <FeatureUnavailable />}

        {shareEnabled && (
          <SectionPanel
            title="Active Shares"
            count={data?.length ?? 0}
            countLabel="active link"
            countLabelPlural="active links"
          >
            {isLoading && (
              <div className="flex items-center gap-2 text-sm text-grey-30 p-6">
                <Loader2 className="size-4 animate-spin" />
                Loading shared links…
              </div>
            )}

            {error && (
              <p className="text-sm text-error-50 p-6">
                Couldn&apos;t load shares: {errorMessage(error)}
              </p>
            )}

            {!isLoading && !error && data && data.length === 0 && <EmptyState />}

            {!isLoading && data && data.length > 0 && (
              <ActiveSharesTable
                rows={data}
                onCopy={onCopy}
                onRevoke={queueRevoke}
                onReshare={onReshare}
                resharingToken={resharingToken}
              />
            )}
          </SectionPanel>
        )}

        {shareEnabled && historyData && historyData.length > 0 && (
          <SectionPanel
            title="History"
            count={historyData.length}
            countLabel="entry"
            countLabelPlural="entries"
            action={
              <button
                onClick={() => setClearAllOpen(true)}
                className="flex items-center gap-1.5 h-9 px-3 rounded text-sm font-medium text-error-60 bg-grey-90 border border-grey-80 hover:bg-error-60 hover:text-white active:bg-error-70 transition-colors focus:outline-none focus:ring-2 focus:ring-error-50"
              >
                <Trash2 className="size-4" />
                Clear all history
              </button>
            }
          >
            <HistoryTable rows={historyData} onRemove={onRemoveHistory} />
          </SectionPanel>
        )}

        <ConfirmDialog
          // Treating `tokenPendingRevoke !== null` as the open signal lets the
          // dialog double as a "which token are we asking about?" carrier —
          // closing it (cancel, escape, outside-click) zeroes the token in
          // `onOpenChange`, so the page settles back to a clean state.
          open={tokenPendingRevoke !== null}
          onOpenChange={(open) => {
            if (!open) setTokenPendingRevoke(null);
          }}
          variant="danger"
          title="Revoke this link?"
          description="Anyone with the link will lose access immediately. This can't be undone."
          confirmText="Revoke"
          cancelText="Cancel"
          onConfirm={confirmRevoke}
          isLoading={revokeBusy}
        />

        <ConfirmDialog
          open={clearAllOpen}
          onOpenChange={setClearAllOpen}
          variant="danger"
          title="Clear all share history?"
          description={`This removes ${historyData?.length ?? 0} entries from this device's history. The shares are already revoked or expired — this only clears the local list.`}
          confirmText="Clear history"
          cancelText="Cancel"
          onConfirm={async () => {
            try {
              await clearShareHistory();
              queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
            } catch (err) {
              toast.error(`Could not clear history: ${errorMessage(err)}`);
            }
          }}
        />
      </div>
    </DashboardTitleWrapper>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section panel                                                             */
/* -------------------------------------------------------------------------- */

interface SectionPanelProps {
  title: string;
  count: number;
  /** Singular label, e.g. `"entry"` — shown when `count === 1`. */
  countLabel: string;
  /** Plural label, e.g. `"entries"` — shown for any count other than 1. */
  countLabelPlural: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Card-like wrapper around each table — title, row count, optional
 * trailing action (e.g. "Clear all history"), and the table body.
 *
 * Plurals are passed as explicit `countLabel` / `countLabelPlural`
 * props rather than synthesised by appending `"s"`, so words like
 * "entry" → "entries" come out right.
 */
function SectionPanel({
  title,
  count,
  countLabel,
  countLabelPlural,
  action,
  children,
}: SectionPanelProps) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-base font-semibold text-grey-10">{title}</h2>
          <span className="text-xs text-grey-50">
            {count} {count === 1 ? countLabel : countLabelPlural}
          </span>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Active shares table                                                       */
/* -------------------------------------------------------------------------- */

const activeColumnHelper = createColumnHelper<ShareSummary>();

interface ActiveSharesTableProps {
  rows: ShareSummary[];
  onCopy: (url: string | null) => void;
  onRevoke: (token: string) => void;
  onReshare: (token: string) => void;
  resharingToken: string | null;
}

function ActiveSharesTable({ rows, onCopy, onRevoke, onReshare, resharingToken }: ActiveSharesTableProps) {
  // Server returns rows newest-first by createdAt. Default the visible
  // sort cursor to that order so the chevron in the column header
  // reflects what the user is actually seeing.
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "created", desc: true },
  ]);

  const columns = React.useMemo(
    () => [
      activeColumnHelper.accessor("filename", {
        id: "name",
        header: "NAME",
        enableSorting: true,
        // Sort by the visible label so cross-device rows ("Created from
        // the console") don't fall through to a confusing "<unknown>".
        sortingFn: (a, b) =>
          pickShareRowDisplay(a.original).text.localeCompare(
            pickShareRowDisplay(b.original).text,
          ),
        cell: (info) => <ActiveNameCell row={info.row.original} />,
      }),
      activeColumnHelper.display({
        id: "link",
        header: "LINK",
        enableSorting: false,
        enableResizing: false,
        cell: ({ row }) => <LinkCell shareUrl={row.original.shareUrl} />,
      }),
      activeColumnHelper.accessor("plaintextSize", {
        id: "size",
        header: "SIZE",
        enableSorting: true,
        cell: (info) => (
          <span className="text-grey-20 text-sm font-medium">
            {formatBytes(info.getValue())}
          </span>
        ),
      }),
      activeColumnHelper.accessor((row) => Date.parse(row.createdAt), {
        id: "created",
        header: "CREATED",
        enableSorting: true,
        cell: (info) => {
          const original = info.row.original.createdAt;
          return <span className="text-grey-20 text-sm">{formatRelative(original)}</span>;
        },
      }),
      activeColumnHelper.accessor((row) => Date.parse(row.expiresAt), {
        id: "endsAt",
        header: "EXPIRES",
        enableSorting: true,
        cell: (info) => {
          const original = info.row.original.expiresAt;
          const ms = Date.parse(original);
          const expired = !Number.isNaN(ms) && ms <= Date.now();
          return (
            <span className={cn("text-sm", expired ? "text-error-50" : "text-grey-20")}>
              {expired ? "Expired" : formatRelative(original)}
            </span>
          );
        },
      }),
      activeColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
        enableResizing: false,
        cell: ({ row }) => (
          <ActiveActionsCell
            row={row.original}
            onCopy={onCopy}
            onRevoke={onRevoke}
            onReshare={onReshare}
            isResharing={row.original.shareToken === resharingToken}
          />
        ),
      }),
    ],
    [onCopy, onRevoke, onReshare, resharingToken],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.shareToken,
  });

  return <RenderedTable table={table} columnWidths={COLUMN_WIDTHS} />;
}

function ActiveNameCell({ row }: { row: ShareSummary }) {
  const display = pickShareRowDisplay(row);
  const expiresMs = Date.parse(row.expiresAt);
  const expired = !Number.isNaN(expiresMs) && expiresMs <= Date.now();

  return (
    <div className="flex items-center gap-3 min-w-0">
      <AbstractIconWrapper className="size-8 shrink-0">
        <Icons.Link className="absolute size-4 text-primary-50" />
      </AbstractIconWrapper>
      {display.isPlaceholder ? (
        <span className="text-sm italic text-grey-50 truncate" title={display.text}>
          {display.text}
        </span>
      ) : (
        <MiddleTruncatedName
          name={display.text}
          textClassName="text-sm font-medium text-grey-10"
          suffix={expired ? <span className="ml-1.5"><Badge tone="muted">Expired</Badge></span> : undefined}
        />
      )}
    </div>
  );
}

function ActiveActionsCell({
  row,
  onCopy,
  onRevoke,
  onReshare,
  isResharing,
}: {
  row: ShareSummary;
  onCopy: (url: string | null) => void;
  onRevoke: (token: string) => void;
  onReshare: (token: string) => void;
  isResharing: boolean;
}) {
  if (isResharing) {
    return (
      <div className="flex justify-center items-center h-8">
        <Loader2 className="size-4 animate-spin text-grey-40" />
      </div>
    );
  }

  const canReshare = Boolean(row.folderLabel && row.relativePath);
  const items: ActionItem[] = [
    {
      icon: <CopyIcon className="size-4" />,
      itemTitle: "Copy link",
      onItemClick: () => onCopy(row.shareUrl),
      disabled: !row.shareUrl,
      tooltip: row.shareUrl
        ? undefined
        : "The link can only be copied from the device that created it.",
    },
    {
      icon: <RefreshCcw className="size-4" />,
      itemTitle: "Reshare",
      onItemClick: () => onReshare(row.shareToken),
      disabled: !canReshare,
      tooltip: canReshare
        ? "Revoke this link and mint a new one with a fresh expiry"
        : "Reshare requires the device that created this link.",
    },
    {
      icon: <Trash2 className="size-4" />,
      itemTitle: "Revoke",
      onItemClick: () => onRevoke(row.shareToken),
      variant: "destructive",
    },
  ];
  return <RowActionMenu items={items} />;
}

/* -------------------------------------------------------------------------- */
/*  History table                                                             */
/* -------------------------------------------------------------------------- */

const historyColumnHelper = createColumnHelper<ShareHistoryEntry>();

interface HistoryTableProps {
  rows: ShareHistoryEntry[];
  onRemove: (token: string) => void;
}

function HistoryTable({ rows, onRemove }: HistoryTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "endsAt", desc: true },
  ]);

  const columns = React.useMemo(
    () => [
      historyColumnHelper.accessor((row) => row.filename ?? "", {
        id: "name",
        header: "NAME",
        enableSorting: true,
        sortingFn: (a, b) =>
          pickHistoryRowDisplay(a.original.filename).text.localeCompare(
            pickHistoryRowDisplay(b.original.filename).text,
          ),
        cell: (info) => <HistoryNameCell entry={info.row.original} />,
      }),
      historyColumnHelper.accessor((row) => row.plaintextSize ?? -1, {
        id: "size",
        header: "SIZE",
        enableSorting: true,
        cell: (info) => {
          const size = info.row.original.plaintextSize;
          return (
            <span className="text-grey-20 text-sm font-medium">
              {size !== null ? formatBytes(size) : "—"}
            </span>
          );
        },
      }),
      historyColumnHelper.accessor((row) => Date.parse(row.createdAt), {
        id: "created",
        header: "CREATED",
        enableSorting: true,
        cell: (info) => (
          <span className="text-grey-20 text-sm">
            {formatRelative(info.row.original.createdAt)}
          </span>
        ),
      }),
      historyColumnHelper.accessor((row) => Date.parse(row.endedAt), {
        id: "endsAt",
        header: "ENDED",
        enableSorting: true,
        cell: (info) => {
          const entry = info.row.original;
          return (
            <span className="text-grey-20 text-sm">
              {historyEndedPhrase(entry.endReason)} {formatRelative(entry.endedAt)}
            </span>
          );
        },
      }),
      historyColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
        enableResizing: false,
        cell: ({ row }) => (
          <RowActionMenu
            items={[
              {
                icon: <Trash2 className="size-4" />,
                itemTitle: "Remove from history",
                onItemClick: () => onRemove(row.original.shareToken),
                variant: "destructive",
              },
            ]}
          />
        ),
      }),
    ],
    [onRemove],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.shareToken,
  });

  return <RenderedTable table={table} columnWidths={HISTORY_COLUMN_WIDTHS} />;
}

function HistoryNameCell({ entry }: { entry: ShareHistoryEntry }) {
  const display = pickHistoryRowDisplay(entry.filename);
  return (
    <div className="flex items-center gap-3 min-w-0">
      <AbstractIconWrapper className="size-8 shrink-0">
        <Icons.Link className="absolute size-4 text-grey-40" />
      </AbstractIconWrapper>
      {display.isPlaceholder ? (
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm italic text-grey-50 truncate" title={display.text}>
            {display.text}
          </span>
          <HistoryStatusBadge reason={entry.endReason} />
        </div>
      ) : (
        <MiddleTruncatedName
          name={display.text}
          textClassName="text-sm font-medium text-grey-10"
          suffix={
            <span className="ml-1.5">
              <HistoryStatusBadge reason={entry.endReason} />
            </span>
          }
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shared table renderer                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Renders a TanStack table through the alt-table primitives so the
 * header (sort chevrons, alignment, uppercase) and body cells match
 * the My Drive table 1:1. Generic over both the active-shares and
 * history row shapes.
 */
function RenderedTable<T>({
  table,
  columnWidths,
}: {
  table: ReturnType<typeof useReactTable<T>>;
  columnWidths: Record<string, number>;
}) {
  return (
    <TableModule.TableWrapper>
      <TableModule.Table className="w-full table-fixed">
        <TableModule.THead>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableModule.Tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableModule.Th
                  key={header.id}
                  header={header}
                  align={header.id === "actions" ? "center" : "left"}
                  columnWidth={columnWidths[header.id]}
                  // Shares table has fixed proportions (CSS-defined), so
                  // hide the resize handle entirely. The drag affordance
                  // adds visual noise without offering anything useful.
                  disableResize
                />
              ))}
            </TableModule.Tr>
          ))}
        </TableModule.THead>
        <TableModule.TBody>
          {table.getRowModel().rows.map((row) => (
            <TableModule.Tr key={row.id} rowHover transparent>
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className={cn(
                    "font-medium px-2.5 py-3 border-x border-grey-80 text-grey-60 text-sm last:border-r-0 first:border-l-0 overflow-hidden align-middle",
                    cell.column.id === "actions" && "p-0",
                  )}
                  style={{ width: `${columnWidths[cell.column.id]}%` }}
                >
                  <div className="w-full min-w-0">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                </td>
              ))}
            </TableModule.Tr>
          ))}
        </TableModule.TBody>
      </TableModule.Table>
    </TableModule.TableWrapper>
  );
}

/**
 * Inline link cell for the active-shares table. Renders a truncated
 * URL with a copy icon that flips to a green check for 2 s after a
 * successful copy. When the key is absent (cross-device share), shows
 * a muted placeholder — the 3-dot menu explains why.
 */
function LinkCell({ shareUrl }: { shareUrl: string | null }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    if (!shareUrl || copied) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success("Link copied to clipboard");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy link");
    }
  };

  if (!shareUrl) {
    return <span className="text-grey-50 text-xs italic">Not available on this device</span>;
  }
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-xs text-primary-50 font-mono truncate" title={shareUrl}>
        {shareUrl}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? "Copied!" : "Copy link"}
        aria-label="Copy link"
        className={cn(
          "shrink-0 p-1 rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-50",
          copied
            ? "text-success-50"
            : "text-grey-40 hover:text-grey-10 hover:bg-grey-90",
        )}
      >
        {copied ? <Check className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </div>
  );
}

function RowActionMenu({ items }: { items: ActionItem[] }) {
  return (
    <div className="flex justify-center items-center">
      <TableActionMenu dropdownTitle="" items={items}>
        <Button
          variant="ghost"
          size="auto"
          className="h-8 w-8 p-0 text-grey-70 action-menu-area"
        >
          <MoreVertical className="size-4" />
        </Button>
      </TableActionMenu>
    </div>
  );
}

/**
 * Subtitle verb for the "ended" half of a history-row subtitle.
 */
function historyEndedPhrase(reason: HistoryEndReason): string {
  switch (reason) {
    case "expired":
      return "expired";
    case "revoked_here":
      return "revoked";
    case "revoked_elsewhere":
      return "revoked elsewhere";
  }
}

function HistoryStatusBadge({ reason }: { reason: HistoryEndReason }) {
  switch (reason) {
    case "expired":
      return <Badge tone="muted">Expired</Badge>;
    case "revoked_here":
      return <Badge tone="error">Revoked</Badge>;
    case "revoked_elsewhere":
      return <Badge tone="muted-italic">Revoked elsewhere</Badge>;
  }
}

function Badge({
  tone,
  children,
}: {
  tone: "muted" | "muted-italic" | "error";
  children: React.ReactNode;
}) {
  const base = "text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0";
  const toneClass =
    tone === "error"
      ? "bg-error-100 text-error-50"
      : tone === "muted-italic"
        ? "bg-grey-90 text-grey-30 italic"
        : "bg-grey-90 text-grey-30";
  return <span className={cn(base, toneClass)}>{children}</span>;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center text-center p-12 bg-white border border-grey-80 rounded-lg">
      <AbstractIconWrapper className="size-12 mb-3">
        <Icons.Link className="absolute size-6 text-primary-50" />
      </AbstractIconWrapper>
      <h3 className="text-grey-10 font-medium text-base">No shared links</h3>
      <p className="text-xs text-grey-60 mt-1 max-w-sm">
        Right-click any synced file and choose &ldquo;Share via link&rdquo; to mint a public link. Active links
        appear here with options to copy, refresh the expiry, or revoke.
      </p>
    </div>
  );
}

function FeatureUnavailable() {
  return (
    <div className="flex flex-col items-center justify-center text-center p-12 bg-white border border-grey-80 rounded-lg">
      <AbstractIconWrapper className="size-12 mb-3">
        <Icons.Link className="absolute size-6 text-grey-40" />
      </AbstractIconWrapper>
      <h3 className="text-grey-10 font-medium text-base">File sharing unavailable</h3>
      <p className="text-xs text-grey-60 mt-1 max-w-sm">
        The connected server doesn&apos;t advertise the file-sharing capability. Update the server, or
        connect to one that supports public links.
      </p>
    </div>
  );
}

