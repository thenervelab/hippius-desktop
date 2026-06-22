"use client";

import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { XCircle } from "lucide-react";

import {
  MiniPaginationControl,
  Pagination,
  SkeletonTableRow,
  TBody,
  THead,
  Table,
  TableWrapper,
  Td,
  Th,
  Tr,
} from "@/components/ui/table";
import { CopyableCell } from "@/components/ui/alt-table";
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ArrowDownToLine, ArrowUpToLine } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

import type {
  BridgeOnChainData,
  BridgeExplorerStatus,
  BridgeTxRow,
} from "@/lib/bridge/types";

import { useLocalWallet } from "@/app/contexts/LocalWalletContext";

/* Bridge transactions tab — mirrors hippius-web's
 * `BridgeTransactionHistoryTable`. Reads bridge deposits + withdrawals
 * from the Rust backend (`bridge_fetch_onchain_data`, which queries the
 * Hippius / Bittensor chains), filters them to the active local wallet's
 * SS58, and renders the same columns + filter + pagination web does.
 *
 * Differences vs web:
 *  - `useActiveWallet` → `useLocalWallet` so the view is scoped to the
 *    desktop's active local wallet.
 *  - The backend already resolves each row's `unifiedStatus`, so there is
 *    no per-row status recomputation here.
 *  - The Bittensor-contract cross-reference was deferred, so there is no
 *    `bittensorSide` detail — the Bittensor columns fall back to "-".
 *  - An in-flight pending row is overlaid from the persisted
 *    bridge-transaction log (`bridge_list_transactions`) rather than a
 *    renderer-side local cache.
 *  - Explorer link uses `https://hipstats.com` directly (matches the
 *    existing pattern used by `ActiveWalletSelector`).
 */

const HIPPIUS_EXPLORER_BASE_URL = "https://hipstats.com";

const BRIDGE_HEADERS = [
  "EXTRINSIC HASH",
  "AMOUNT",
  "BITTENSOR CHAIN",
  "BITTENSOR BLOCK",
  "VOTES",
  "HIPPIUS CHAIN",
  "HIPPIUS BLOCK",
];
const BRIDGE_SKELETON_WIDTHS = [
  "70%",
  "80px",
  "80px",
  "60px",
  "50px",
  "80px",
  "60px",
];

const ITEMS_PER_PAGE_DEFAULT = 10;

type FilterType = "all" | "deposits" | "withdrawals";

interface BridgeTransaction {
  id: string;
  type: "deposit" | "withdrawal";
  recipient?: string;
  sender?: string;
  amount: string;
  btStatus: string;
  btBlock: string;
  hVotes: string;
  hStatus: string;
  hBlock: string;
  overallStatus: BridgeExplorerStatus;
  isPending?: boolean;
}

/* ── StatusBadge ──────────────────────────────────────────────── */

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const lower = status.toLowerCase();

  let colorClasses: string;

  if (lower === "completed" || lower === "locked" || lower === "burned") {
    colorClasses =
      "border-[#6CE9A6] bg-[#DAFBE8] text-[#04C870] dark:border-[#03301E] dark:bg-[#03301E] dark:text-[#6CE9A6]";
  } else if (
    lower === "failed" ||
    lower === "denied" ||
    lower === "expired"
  ) {
    colorClasses =
      "bg-red-50 border-red-200 text-red-600 dark:bg-red-950/40 dark:border-red-900 dark:text-red-400";
  } else if (
    lower === "pending" ||
    lower === "requested" ||
    lower === "submitting"
  ) {
    colorClasses =
      "border-[#FEC134] bg-[#FFF2CC] text-[#E89702] dark:border-[#793902] dark:bg-[#793902] dark:text-[#E89702]";
  } else if (lower === "processing" || lower === "in-progress") {
    colorClasses =
      "bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-900 dark:text-blue-400";
  } else {
    colorClasses =
      "bg-grey-90 border-grey-80 text-grey-60 dark:bg-black-600 dark:border-black-300 dark:text-grey-dark-700";
  }

  return (
    <span
      className={cn(
        // Em-based geometry (0.67em≈8px, 0.33em≈4px, 1.34lh≈16px,
        // -0.02em=-0.24px at the 12px text-xs size): WKWebView's pageZoom
        // clamps small fonts (~9px floor) on zoom-out, so px/rem geometry
        // (incl. text-xs's baked-in 1rem line-height) shrinks away from the
        // text and crams the pill; em tracks the clamped font size.
        "inline-flex items-center justify-center whitespace-nowrap rounded-full border px-[0.67em] py-[0.33em] text-xs leading-[1.34] font-semibold tracking-[-0.02em]",
        colorClasses,
      )}
    >
      {status}
    </span>
  );
};

/* ── Columns ─────────────────────────────────────────────────── */

const columnHelper = createColumnHelper<BridgeTransaction>();

/* Column widths are tuned so the table fits on a ~13" laptop without
 * horizontal scroll. Total minimum row width ~ 920px (matches the
 * `min-w-[960px]` on <Table>). The EXTRINSIC HASH column gets the
 * largest slice because it's the only truly variable-length value;
 * everything else is a badge / number / short label. */
const columns = [
  columnHelper.accessor("id", {
    id: "id",
    header: "EXTRINSIC HASH",
    meta: { headerClassName: "w-[200px]", cellClassName: "w-[200px]" },
    cell: (d) => (
      <CopyableCell
        copyAbleText={d.getValue()}
        link={`${HIPPIUS_EXPLORER_BASE_URL}/extrinsics/${d.getValue()}`}
        title="Copy Extrinsic Hash"
        toastMessage="Extrinsic Hash Copied Successfully!"
        linkClass="text-grey-20 hover:text-primary-50 dark:text-grey-dark-200 dark:hover:text-primary-65"
        isTable
      />
    ),
    enableSorting: false,
  }),
  columnHelper.accessor("amount", {
    id: "amount",
    header: "AMOUNT",
    meta: { headerClassName: "w-[110px]", cellClassName: "w-[110px]" },
    cell: (d) => {
      const row = d.row.original;
      const token = row.type === "deposit" ? "hALPHA" : "ALPHA";
      return (
        <>
          {d.getValue()} {token}
        </>
      );
    },
    enableSorting: true,
  }),
  columnHelper.accessor("btStatus", {
    id: "btStatus",
    header: "BITTENSOR CHAIN",
    meta: { headerClassName: "w-[130px]", cellClassName: "w-[130px]" },
    cell: (d) =>
      d.getValue() && d.getValue() !== "-" ? (
        <StatusBadge status={d.getValue()} />
      ) : (
        <span className="text-grey-60">-</span>
      ),
    enableSorting: false,
  }),
  columnHelper.accessor("btBlock", {
    id: "btBlock",
    header: "BITTENSOR BLOCK",
    meta: { headerClassName: "w-[100px]", cellClassName: "w-[100px]" },
    cell: (d) => (
      <span className="text-grey-10 dark:text-grey-dark-200 font-semibold tabular-nums">
        {d.getValue() || "-"}
      </span>
    ),
    enableSorting: true,
  }),
  columnHelper.accessor("hVotes", {
    id: "hVotes",
    header: "VOTES",
    meta: { headerClassName: "w-[64px]", cellClassName: "w-[64px]" },
    cell: (d) => (
      <span
        className={cn(
          "font-semibold tabular-nums",
          d.getValue().startsWith("3/") ? "text-[#04c870]" : "text-grey-50",
        )}
      >
        {d.getValue()}
      </span>
    ),
    enableSorting: false,
  }),
  columnHelper.accessor("hStatus", {
    id: "hStatus",
    header: "HIPPIUS CHAIN",
    meta: { headerClassName: "w-[120px]", cellClassName: "w-[120px]" },
    cell: (d) => <StatusBadge status={d.getValue()} />,
    enableSorting: false,
  }),
  columnHelper.accessor("hBlock", {
    id: "hBlock",
    header: "HIPPIUS BLOCK",
    meta: { headerClassName: "w-[100px]", cellClassName: "w-[100px]" },
    cell: (d) => (
      <span className="text-grey-10 dark:text-grey-dark-200 font-semibold tabular-nums">
        {d.getValue() || "-"}
      </span>
    ),
    enableSorting: true,
  }),
];

/* ── Component ───────────────────────────────────────────────── */

interface BridgeTransactionHistoryTableProps {
  /** Portal target for rendering filter controls in the parent tab bar
   *  — same pattern hippius-web uses. */
  headerPortalTarget?: HTMLElement | null;
}

const BridgeTransactionHistoryTable: React.FC<
  BridgeTransactionHistoryTableProps
> = ({ headerPortalTarget }) => {
  const { activeWallet } = useLocalWallet();
  const effectiveAddress = activeWallet?.address ?? "";

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(ITEMS_PER_PAGE_DEFAULT);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

  /* Pull deposits + withdrawals from the Rust backend (which queries the
   * chains), same cadence web uses. */
  const {
    data: explorerData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["bridge-explorer-data"],
    queryFn: () => invoke<BridgeOnChainData>("bridge_fetch_onchain_data"),
    staleTime: 10_000,
    refetchInterval: 15_000,
    enabled: !!effectiveAddress,
  });

  /* Persisted bridge-transaction log — used only to overlay an in-flight
   * "pending" row that the on-chain explorer hasn't surfaced yet. */
  const { data: txList } = useQuery({
    queryKey: ["bridge-tx-list"],
    queryFn: () => invoke<BridgeTxRow[]>("bridge_list_transactions"),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  /* Approval threshold for the votes column comes from the chain
   * snapshot. The Bittensor cross-ref is deferred, so vote counts are
   * Hippius-side only. */
  const threshold = explorerData?.stats?.approveThreshold ?? 3;

  /* Filter to the active local wallet's SS58 so switching wallets
   * doesn't leak other accounts' history into the view. */
  const { deposits, withdrawals } = useMemo(() => {
    if (!effectiveAddress || !explorerData) {
      return { deposits: [], withdrawals: [] };
    }

    const filteredDeposits = explorerData.deposits.filter(
      (d) => d.recipient.toLowerCase() === effectiveAddress.toLowerCase(),
    );
    const filteredWithdrawals = explorerData.withdrawals.filter(
      (w) => w.sender.toLowerCase() === effectiveAddress.toLowerCase(),
    );

    return { deposits: filteredDeposits, withdrawals: filteredWithdrawals };
  }, [explorerData, effectiveAddress]);

  const getHpsStatus = (
    voteCount: number,
    thresholdCount: number,
    originalStatus: string,
    txType: "deposit" | "withdrawal",
  ): string => {
    if (voteCount >= thresholdCount) {
      return txType === "withdrawal" ? "Burned" : "Completed";
    }
    return originalStatus;
  };

  /* Unify deposits + withdrawals into the row shape the table expects,
   * overlaying a single in-flight pending row if applicable. The backend
   * already resolves `unifiedStatus`, so it is used directly, and supplies the
   * best-effort `bittensorSide` cross-ref (null → the Bittensor columns "-"). */
  const allTransactions = useMemo(() => {
    const depositTxs: BridgeTransaction[] = deposits.map((d) => {
      const hpsStatus = getHpsStatus(d.voteCount, threshold, d.status, "deposit");
      return {
        id: d.requestId,
        type: "deposit" as const,
        recipient: d.recipient,
        amount: d.amountDisplay,
        btStatus:
          d.bittensorSide?.status === "Requested"
            ? "Locked"
            : d.bittensorSide?.status ?? "-",
        btBlock: d.bittensorSide?.createdAtBlock ?? "-",
        hVotes: `${d.voteCount}/${threshold}`,
        hStatus: hpsStatus,
        hBlock: d.createdAtBlock,
        overallStatus: d.unifiedStatus,
      };
    });

    const withdrawalTxs: BridgeTransaction[] = withdrawals.map((w) => {
      const withdrawalVoteCount = w.bittensorSide?.voteCount ?? 0;
      const hpsStatus = getHpsStatus(
        withdrawalVoteCount,
        threshold,
        w.status,
        "withdrawal",
      );
      return {
        id: w.requestId,
        type: "withdrawal" as const,
        sender: w.sender,
        amount: w.amountDisplay,
        btStatus: w.bittensorSide?.status ?? "-",
        btBlock: w.bittensorSide?.createdAtBlock ?? "-",
        hVotes: `${withdrawalVoteCount}/${threshold}`,
        hStatus: hpsStatus,
        hBlock: w.createdAtBlock,
        overallStatus: w.unifiedStatus,
      };
    });

    /* In-flight overlay: the first still-pending row from the persisted
     * log that matches this wallet and isn't already on chain. Matched by
     * the deposit/withdrawal id so a confirmed row doesn't double-render. */
    const onChainIds = new Set<string>([
      ...depositTxs.map((d) => d.id),
      ...withdrawalTxs.map((w) => w.id),
    ]);

    const pendingTransactions: BridgeTransaction[] = [];
    const pendingRow = (txList ?? []).find((row) => {
      if (row.status !== "pending") return false;
      const isDeposit = row.direction === "alpha-to-halpha";
      const party = isDeposit ? row.recipient : row.sender;
      if (
        !party ||
        party.toLowerCase() !== effectiveAddress.toLowerCase()
      ) {
        return false;
      }
      const id = isDeposit ? row.depositId : row.withdrawalId;
      // Treat as in-flight only while not yet reflected on chain.
      return !id || !onChainIds.has(id);
    });

    if (effectiveAddress && pendingRow) {
      const isDeposit = pendingRow.direction === "alpha-to-halpha";
      pendingTransactions.push({
        id: pendingRow.id,
        type: isDeposit ? "deposit" : "withdrawal",
        recipient: isDeposit ? pendingRow.recipient ?? undefined : undefined,
        sender: !isDeposit ? pendingRow.sender ?? undefined : undefined,
        // Display the raw rao string the backend stored; the on-chain row
        // (with its formatted `amountDisplay`) replaces it once confirmed.
        amount: pendingRow.amount,
        btStatus: "-",
        btBlock: "-",
        hVotes: `0/${threshold}`,
        hStatus: isDeposit ? "Pending" : "Submitting",
        hBlock: "-",
        overallStatus: "pending",
        isPending: true,
      });
    }

    return [...pendingTransactions, ...depositTxs, ...withdrawalTxs].sort(
      (a, b) => {
        if (a.isPending && !b.isPending) return -1;
        if (!a.isPending && b.isPending) return 1;
        return parseInt(b.hBlock || "0") - parseInt(a.hBlock || "0");
      },
    );
  }, [deposits, withdrawals, threshold, effectiveAddress, txList]);

  /* Filter + counts for the segmented control. */
  const filteredTransactions = useMemo(() => {
    if (activeFilter === "all") return allTransactions;
    if (activeFilter === "deposits")
      return allTransactions.filter((t) => t.type === "deposit");
    return allTransactions.filter((t) => t.type === "withdrawal");
  }, [allTransactions, activeFilter]);

  const depositCount = allTransactions.filter((t) => t.type === "deposit").length;
  const withdrawalCount = allTransactions.filter(
    (t) => t.type === "withdrawal",
  ).length;
  const totalCount = allTransactions.length;

  /* Pagination. */
  const totalPages = Math.max(1, Math.ceil(filteredTransactions.length / pageSize));
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    return filteredTransactions.slice(startIndex, startIndex + pageSize);
  }, [filteredTransactions, currentPage, pageSize]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, pageSize, effectiveAddress]);

  const table = useReactTable({
    data: paginatedData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const filterOptions = useMemo(
    () => [
      { value: "all" as const, label: `All(${totalCount})` },
      {
        value: "deposits" as const,
        label: (
          <>
            <ArrowDownToLine className="size-3" />
            Deposit({depositCount})
          </>
        ),
      },
      {
        value: "withdrawals" as const,
        label: (
          <>
            <ArrowUpToLine className="size-3" />
            Withdrawal({withdrawalCount})
          </>
        ),
      },
    ],
    [totalCount, depositCount, withdrawalCount],
  );

  const showPagination = filteredTransactions.length > ITEMS_PER_PAGE_DEFAULT;

  const headerControls = (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl
        ariaLabel="Bridge transaction filter"
        options={filterOptions}
        value={activeFilter}
        onChange={(value) => setActiveFilter(value)}
        showActiveIndicator={false}
      />
      {showPagination && (
        <MiniPaginationControl
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          totalCount={filteredTransactions.length}
          onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
          onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
        />
      )}
    </div>
  );

  if (isLoading && allTransactions.length === 0) {
    return (
      <>
        {headerPortalTarget && createPortal(headerControls, headerPortalTarget)}
        <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
          <div className="overflow-x-auto custom-scrollbar-thin">
            <Table className="min-w-[960px]">
              <THead>
                <Tr className="bg-[#fefefe] dark:bg-black-primary-bg">
                  {BRIDGE_HEADERS.map((h) => (
                    <th
                      key={h}
                      className="h-[var(--table-row-height,36px)] border-b border-r border-grey-dark-100 px-[var(--table-cell-padding-x,10px)] py-0 text-left text-[length:var(--table-header-font-size,10px)] leading-[var(--table-header-line-height,14px)] font-semibold uppercase text-grey-dark-600 last:border-r-0 dark:border-black-300 dark:text-grey-dark-700"
                    >
                      {h}
                    </th>
                  ))}
                </Tr>
              </THead>
              <TBody>
                <SkeletonTableRow
                  rows={pageSize}
                  columns={BRIDGE_HEADERS.length}
                  columnWidths={BRIDGE_SKELETON_WIDTHS}
                />
              </TBody>
            </Table>
          </div>
        </TableWrapper>
      </>
    );
  }

  if (error && allTransactions.length === 0) {
    return (
      <>
        {headerPortalTarget && createPortal(headerControls, headerPortalTarget)}
        <div className="flex flex-col items-center justify-center py-12">
          <XCircle className="w-8 h-8 text-red-500 mb-2" />
          <span className="text-grey-50 dark:text-grey-dark-600 text-sm">
            Failed to load bridge transactions
          </span>
          <button
            onClick={() => refetch()}
            className="mt-2 text-primary-50 text-sm hover:underline"
          >
            Retry
          </button>
        </div>
      </>
    );
  }

  return (
    <div>
      {headerPortalTarget && createPortal(headerControls, headerPortalTarget)}

      {filteredTransactions.length === 0 ? (
        <NoEntriesFound
          title={
            effectiveAddress
              ? "No bridge transactions found"
              : "Wallet not connected"
          }
          description={
            effectiveAddress
              ? "Bridge some tokens to see your transaction history"
              : "Unlock or create a local wallet to view your bridge transactions"
          }
          className="h-[350px]"
        />
      ) : (
        <>
          <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
            <div className="overflow-x-auto custom-scrollbar-thin">
              <Table className="min-w-[960px]">
                <THead>
                  {table.getHeaderGroups().map((hg) => (
                    <Tr
                      key={hg.id}
                      className="bg-[#fefefe] dark:bg-black-primary-bg"
                    >
                      {hg.headers.map((h) => (
                        <Th key={h.id} header={h} />
                      ))}
                    </Tr>
                  ))}
                </THead>
                <TBody>
                  {table.getRowModel().rows.map((row) => (
                    <Tr
                      key={row.id}
                      transparent
                      className={cn(
                        "bg-white dark:bg-black-600",
                        row.original.isPending &&
                          "bg-amber-50/10 dark:bg-amber-900/10",
                      )}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <Td
                          className="text-[#1D1D1D] dark:text-[#DBDBDB] font-semibold"
                          key={cell.id}
                          cell={cell}
                        />
                      ))}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </div>
          </TableWrapper>

          {showPagination && (
            <div className="mt-2">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                setPage={setCurrentPage}
                totalCount={filteredTransactions.length}
                pageSize={pageSize}
                setPageSize={setPageSize}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default BridgeTransactionHistoryTable;
