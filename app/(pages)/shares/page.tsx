"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useAtomValue } from "jotai";
import {
  Check,
  Copy as CopyIcon,
  Loader2,
  MoreVertical,
  RefreshCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import { AbstractIconWrapper, Icons } from "@/components/ui";
import MiddleTruncatedName from "@/components/ui/MiddleTruncatedName";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableWrapper,
  THead,
  TBody,
  Tr,
  Th,
  Td,
} from "@/components/ui/table";
import TableActionMenu, {
  type ActionItem,
} from "@/app/components/ui/alt-table/TableActionMenu";
import { FramedDialog } from "@/components/ui/FramedDialog";
import {
  listShares,
  reshare,
  revokeShare,
  type ShareSummary,
} from "@/app/lib/tauri/shares";
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
import { LIVE_DATA_REFRESH_MS } from "@/lib/constants";
import { pickHistoryRowDisplay } from "./shareRowDisplay";

const SHARES_QUERY_KEY = "shares-list";
const HISTORY_QUERY_KEY = "shares-history-list";

// Destructive accent — matches drive/DeleteConfirmationDialog so the
// "revoke this link" and "clear history" framed dialogs read as
// destructive (red frame border + red icon badge).
const DESTRUCTIVE_BG = "bg-[#fc7d73]";

export default function MySharesPage() {
  const { polkadotAddress } = useWalletAuth();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [tokenPendingRevoke, setTokenPendingRevoke] = React.useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);
  const [resharingToken, setResharingToken] = React.useState<string | null>(null);
  const [clearAllOpen, setClearAllOpen] = React.useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: [SHARES_QUERY_KEY, polkadotAddress],
    queryFn: () => listShares(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: LIVE_DATA_REFRESH_MS,
  });

  const { data: historyData } = useQuery({
    queryKey: [HISTORY_QUERY_KEY, polkadotAddress],
    queryFn: () => listShareHistory(),
    enabled: Boolean(polkadotAddress) && shareEnabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: LIVE_DATA_REFRESH_MS,
  });

  const queueRevoke = (token: string) => setTokenPendingRevoke(token);

  const confirmRevoke = async () => {
    if (!tokenPendingRevoke) return;
    setRevokeBusy(true);
    try {
      await revokeShare(tokenPendingRevoke);
      toast.success("Share link revoked");
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
      queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
    } catch (err) {
      toast.error(`Could not remove from history: ${errorMessage(err)}`);
    }
  };

  const onReshare = async (token: string) => {
    setResharingToken(token);
    try {
      const link = await reshare(token);
      try {
        await navigator.clipboard.writeText(link.shareUrl);
        toast.success("New link copied to clipboard");
      } catch {
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
      <div className="flex flex-col px-4 pb-6">
        <button
          onClick={() => router.push("/files")}
          className="mt-3 mb-4 flex items-center gap-2 font-semibold text-base text-grey-10 dark:text-grey-light-100 hover:text-primary-50 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-2 w-fit"
        >
          <Icons.ArrowLeft className="size-4" />
          Back
        </button>

        {!shareEnabled && <FeatureUnavailable />}

        {shareEnabled && (
          <div className="flex flex-col gap-6">
            {/* Active Shares card */}
            <SectionCard
              title="Active Shares"
              count={data?.length ?? 0}
              countLabel="active link"
              countLabelPlural="active links"
            >
              {isLoading && (
                <div className="flex items-center gap-2 text-sm text-grey-40 dark:text-grey-dark-600 px-4 py-6">
                  <Loader2 className="size-4 animate-spin" />
                  Loading shared links…
                </div>
              )}
              {error && (
                <p className="text-sm text-error-50 px-4 py-6">
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
            </SectionCard>

            {/* History card */}
            {historyData && historyData.length > 0 && (
              <SectionCard
                title="History"
                count={historyData.length}
                countLabel="entry"
                countLabelPlural="entries"
                action={
                  <button
                    onClick={() => setClearAllOpen(true)}
                    className="flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-error-60 bg-white border border-grey-dark-100 hover:bg-error-60 hover:text-white active:bg-error-70 transition-colors focus:outline-none focus:ring-2 focus:ring-error-50 dark:bg-black-500 dark:border-black-300 dark:text-error-50 dark:hover:bg-error-60 dark:hover:text-white"
                  >
                    <Trash2 className="size-3.5" />
                    Clear all
                  </button>
                }
              >
                <HistoryTable rows={historyData} onRemove={onRemoveHistory} />
              </SectionCard>
            )}
          </div>
        )}

        {/* Revoke confirmation */}
        <FramedDialog
          open={tokenPendingRevoke !== null}
          onClose={() => { if (!revokeBusy) setTokenPendingRevoke(null); }}
          title="Revoke this link?"
          icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
          borderClassName={DESTRUCTIVE_BG}
          iconBgClassName={DESTRUCTIVE_BG}
          maxWidth="max-w-[585px]"
          cardClassName="bg-white dark:bg-[#161616]"
          contentClassName="sm:w-[405px]"
        >
          <p className="mb-6 text-center text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-20 dark:text-grey-dark-700 font-geist">
            Anyone with the link will lose access immediately. This can&apos;t be undone.
          </p>
          <Button
            variant="destructive"
            size="auto"
            onClick={confirmRevoke}
            disabled={revokeBusy}
            loading={revokeBusy}
            className="h-[52px] w-full text-white"
          >
            {revokeBusy ? "Revoking…" : "Revoke link"}
          </Button>
          <Button
            variant="defaultStable"
            size="auto"
            onClick={() => setTokenPendingRevoke(null)}
            disabled={revokeBusy}
            className={cn(
              "mt-3 h-[52px] w-full rounded-[6px] border bg-transparent text-base font-normal tracking-[-0.36px]",
              "border-[#e3e3e3] text-grey-10 hover:bg-grey-90",
              "dark:border-[#494949] dark:text-white dark:hover:bg-[#2c2c2c]",
            )}
          >
            Cancel
          </Button>
        </FramedDialog>

        {/* Clear history confirmation */}
        <FramedDialog
          open={clearAllOpen}
          onClose={() => setClearAllOpen(false)}
          title="Clear all share history?"
          icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
          borderClassName={DESTRUCTIVE_BG}
          iconBgClassName={DESTRUCTIVE_BG}
          maxWidth="max-w-[585px]"
          cardClassName="bg-white dark:bg-[#161616]"
          contentClassName="sm:w-[405px]"
        >
          <p className="mb-6 text-center text-base font-medium leading-[22px] tracking-[-0.32px] text-grey-20 dark:text-grey-dark-700 font-geist">
            This removes {historyData?.length ?? 0}{" "}
            {(historyData?.length ?? 0) === 1 ? "entry" : "entries"} from this device&apos;s history.
            The shares are already revoked or expired — this only clears the local list.
          </p>
          <Button
            variant="destructive"
            size="auto"
            onClick={async () => {
              try {
                await clearShareHistory();
                queryClient.invalidateQueries({ queryKey: [HISTORY_QUERY_KEY, polkadotAddress] });
                setClearAllOpen(false);
              } catch (err) {
                toast.error(`Could not clear history: ${errorMessage(err)}`);
              }
            }}
            className="h-[52px] w-full text-white"
          >
            Clear history
          </Button>
          <Button
            variant="defaultStable"
            size="auto"
            onClick={() => setClearAllOpen(false)}
            className={cn(
              "mt-3 h-[52px] w-full rounded-[6px] border bg-transparent text-base font-normal tracking-[-0.36px]",
              "border-[#e3e3e3] text-grey-10 hover:bg-grey-90",
              "dark:border-[#494949] dark:text-white dark:hover:bg-[#2c2c2c]",
            )}
          >
            Cancel
          </Button>
        </FramedDialog>
      </div>
    </DashboardTitleWrapper>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section card — billing-style outer card with mono header                 */
/* -------------------------------------------------------------------------- */

interface SectionCardProps {
  title: string;
  count: number;
  countLabel: string;
  countLabelPlural: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}

function SectionCard({ title, count, countLabel, countLabelPlural, action, children }: SectionCardProps) {
  return (
    <div className="flex flex-col items-center w-full rounded-[8px] border overflow-hidden bg-grey-light-300 border-grey-dark-100 dark:bg-black-primary-bg dark:border-black-300 shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)]">
      {/* Header row */}
      <div className="flex h-[46px] w-full items-center justify-between pl-[14px] pr-[10px]">
        <div className="flex items-baseline gap-2">
          <p className="font-mono font-medium text-[12px] leading-[18px] tracking-[-0.24px] text-primary-40 dark:text-primary-brand-dark uppercase">
            {title}
          </p>
          <span className="text-[11px] text-grey-50 dark:text-grey-dark-600">
            {count} {count === 1 ? countLabel : countLabelPlural}
          </span>
        </div>
        {action}
      </div>
      {/* Inner white card */}
      <div className="flex flex-col w-full flex-1 border-t border-grey-dark-100 bg-white dark:bg-black-600 dark:border-black-300 overflow-hidden">
        {children}
      </div>
    </div>
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
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "created", desc: true }]);

  const columns = React.useMemo(
    () => [
      activeColumnHelper.accessor("filename", {
        id: "name",
        header: "Name",
        enableSorting: true,
        cell: (info) => <ActiveNameCell row={info.row.original} />,
      }),
      activeColumnHelper.display({
        id: "link",
        header: "Link",
        enableSorting: false,
        cell: ({ row }) => <LinkCell shareUrl={row.original.shareUrl} />,
      }),
      activeColumnHelper.accessor("plaintextSize", {
        id: "size",
        header: "Size",
        enableSorting: true,
        cell: (info) => (
          <span className="font-medium text-grey-20 dark:text-grey-dark-200">
            {formatBytes(info.getValue())}
          </span>
        ),
      }),
      activeColumnHelper.accessor((row) => Date.parse(row.createdAt), {
        id: "created",
        header: "Created",
        enableSorting: true,
        cell: (info) => (
          <span className="font-medium text-grey-20 dark:text-grey-dark-200">
            {formatRelative(info.row.original.createdAt)}
          </span>
        ),
      }),
      activeColumnHelper.accessor((row) => Date.parse(row.expiresAt), {
        id: "endsAt",
        header: "Expires",
        enableSorting: true,
        cell: (info) => {
          const original = info.row.original.expiresAt;
          const ms = Date.parse(original);
          const expired = !Number.isNaN(ms) && ms <= Date.now();
          return (
            <span className={cn("font-medium", expired ? "text-error-50" : "text-grey-20 dark:text-grey-dark-200")}>
              {expired ? "Expired" : formatRelative(original)}
            </span>
          );
        },
      }),
      activeColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
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

  return (
    <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
      <div className="overflow-x-auto custom-scrollbar-thin">
        <Table className="min-w-[540px]">
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
              <Tr key={row.id}>
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
  );
}

function ActiveNameCell({ row }: { row: ShareSummary }) {
  const expiresMs = Date.parse(row.expiresAt);
  const expired = !Number.isNaN(expiresMs) && expiresMs <= Date.now();

  return (
    <div className="flex items-center gap-2 min-w-0 max-w-[260px]">
      <Icons.Link className="size-3.5 shrink-0 text-primary-50" />
      <MiddleTruncatedName
        name={row.filename}
        textClassName="text-xs font-medium text-grey-20 dark:text-grey-dark-200"
        suffix={
          expired ? (
            <span className="ml-1.5">
              <Badge tone="muted">Expired</Badge>
            </span>
          ) : undefined
        }
      />
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
        <Loader2 className="size-4 animate-spin text-grey-40 dark:text-grey-dark-600" />
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
      tooltip: row.shareUrl ? undefined : "The link can only be copied from the device that created it.",
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
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "endsAt", desc: true }]);

  const columns = React.useMemo(
    () => [
      historyColumnHelper.accessor((row) => row.filename ?? "", {
        id: "name",
        header: "Name",
        enableSorting: true,
        sortingFn: (a, b) =>
          pickHistoryRowDisplay(a.original.filename).text.localeCompare(
            pickHistoryRowDisplay(b.original.filename).text,
          ),
        cell: (info) => <HistoryNameCell entry={info.row.original} />,
      }),
      historyColumnHelper.accessor((row) => row.plaintextSize ?? -1, {
        id: "size",
        header: "Size",
        enableSorting: true,
        cell: (info) => {
          const size = info.row.original.plaintextSize;
          return (
            <span className="font-medium text-grey-20 dark:text-grey-dark-200">
              {size !== null ? formatBytes(size) : "—"}
            </span>
          );
        },
      }),
      historyColumnHelper.accessor((row) => Date.parse(row.createdAt), {
        id: "created",
        header: "Created",
        enableSorting: true,
        cell: (info) => (
          <span className="font-medium text-grey-20 dark:text-grey-dark-200">
            {formatRelative(info.row.original.createdAt)}
          </span>
        ),
      }),
      historyColumnHelper.accessor((row) => Date.parse(row.endedAt), {
        id: "endsAt",
        header: "Ended",
        enableSorting: true,
        cell: (info) => {
          const entry = info.row.original;
          return (
            <span className="font-medium text-grey-20 dark:text-grey-dark-200">
              {historyEndedPhrase(entry.endReason)} {formatRelative(entry.endedAt)}
            </span>
          );
        },
      }),
      historyColumnHelper.display({
        id: "actions",
        header: "",
        enableSorting: false,
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

  return (
    <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
      <div className="overflow-x-auto custom-scrollbar-thin">
        <Table className="min-w-[400px]">
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
              <Tr key={row.id}>
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
  );
}

function HistoryNameCell({ entry }: { entry: ShareHistoryEntry }) {
  const display = pickHistoryRowDisplay(entry.filename);
  return (
    <div className="flex items-center gap-2 min-w-0 max-w-[260px]">
      <Icons.Link className="size-3.5 shrink-0 text-grey-40 dark:text-grey-dark-600" />
      {display.isPlaceholder ? (
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs italic text-grey-50 dark:text-grey-dark-600 truncate" title={display.text}>
            {display.text}
          </span>
          <HistoryStatusBadge reason={entry.endReason} />
        </div>
      ) : (
        <MiddleTruncatedName
          name={display.text}
          textClassName="text-xs font-medium text-grey-20 dark:text-grey-dark-200"
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
/*  Link cell                                                                 */
/* -------------------------------------------------------------------------- */

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
    return (
      <span className="text-xs italic text-grey-50 dark:text-grey-dark-600">
        Not available on this device
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0 max-w-[320px]">
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
            : "text-grey-40 hover:text-grey-10 hover:bg-grey-90 dark:text-grey-dark-600 dark:hover:text-white dark:hover:bg-black-400",
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
          className="h-6 w-6 p-0 text-grey-50 dark:text-grey-dark-600 hover:text-grey-10 dark:hover:text-white action-menu-area"
        >
          <MoreVertical className="size-4" />
        </Button>
      </TableActionMenu>
    </div>
  );
}

function historyEndedPhrase(reason: HistoryEndReason): string {
  switch (reason) {
    case "expired":      return "Expired";
    case "revoked_here": return "Revoked";
    case "revoked_elsewhere": return "Revoked elsewhere";
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

function Badge({ tone, children }: { tone: "muted" | "muted-italic" | "error"; children: React.ReactNode }) {
  const base = "text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0";
  const toneClass =
    tone === "error"
      ? "bg-error-100 text-error-50 dark:bg-error-50/20 dark:text-error-50"
      : tone === "muted-italic"
        ? "bg-grey-90 text-grey-30 italic dark:bg-black-400 dark:text-grey-dark-600"
        : "bg-grey-90 text-grey-30 dark:bg-black-400 dark:text-grey-dark-600";
  return <span className={cn(base, toneClass)}>{children}</span>;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10">
      <AbstractIconWrapper className="size-10 mb-2.5">
        <Icons.Link className="absolute size-5 text-primary-50" />
      </AbstractIconWrapper>
      <h3 className="text-grey-10 dark:text-grey-light-100 font-medium text-sm">No shared links</h3>
      <p className="text-xs text-grey-60 dark:text-grey-dark-600 mt-1 max-w-sm">
        Right-click any synced file and choose &ldquo;Share via link&rdquo; to mint a public link.
        Active links appear here with options to copy, refresh the expiry, or revoke.
      </p>
    </div>
  );
}

function FeatureUnavailable() {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10 bg-white dark:bg-black-600 border border-grey-dark-100 dark:border-black-300 rounded-[8px]">
      <AbstractIconWrapper className="size-10 mb-2.5">
        <Icons.Link className="absolute size-5 text-grey-40 dark:text-grey-dark-600" />
      </AbstractIconWrapper>
      <h3 className="text-grey-10 dark:text-grey-light-100 font-medium text-sm">File sharing unavailable</h3>
      <p className="text-xs text-grey-60 dark:text-grey-dark-600 mt-1 max-w-sm">
        The connected server doesn&apos;t advertise the file-sharing capability. Update the server, or
        connect to one that supports public links.
      </p>
    </div>
  );
}
