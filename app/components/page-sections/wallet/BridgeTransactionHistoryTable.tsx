"use client";

import React, { useMemo, useState } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

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
import { cn } from "@/lib/utils";

import {
  formatBridgeAmount,
  useBridge,
  type TrackedBridgeTransaction,
} from "@/lib/hooks/api/useBridge";

/* Bridge transactions tab. Reads from the Rust `bridge_transactions`
 * cache via `useBridge` so the same hook backs both this history table
 * and the submit dialog — a successful submit lights up here via the
 * tx-updated event without a manual refresh. */

const HEADERS = [
  "DIRECTION",
  "AMOUNT",
  "STATUS",
  "RECIPIENT",
  "TX HASH",
  "DATE",
];
const SKEL_WIDTHS = ["120px", "120px", "100px", "160px", "140px", "120px"];
const MIN_W = "min-w-[640px] sm:min-w-[900px]";
const DEFAULT_PAGE_SIZE = 10;

const col = createColumnHelper<TrackedBridgeTransaction>();

const directionLabel = (d: TrackedBridgeTransaction["direction"]): string =>
  d === "halpha-to-alpha" ? "hALPHA → ALPHA" : "ALPHA → hALPHA";

const statusStyles: Record<
  TrackedBridgeTransaction["status"],
  { dot: string; text: string; label: string }
> = {
  pending: {
    dot: "bg-warning-50",
    text: "text-warning-90 dark:text-warning-30",
    label: "Pending",
  },
  confirmed: {
    dot: "bg-primary-50",
    text: "text-primary-50 dark:text-primary-brand-dark",
    label: "Confirmed",
  },
  processing: {
    dot: "bg-primary-50",
    text: "text-primary-50 dark:text-primary-brand-dark",
    label: "Processing",
  },
  completed: {
    dot: "bg-success-50",
    text: "text-success-70 dark:text-success-30",
    label: "Completed",
  },
  failed: {
    dot: "bg-error-50",
    text: "text-error-70 dark:text-error-30",
    label: "Failed",
  },
  unknown: {
    dot: "bg-grey-40",
    text: "text-grey-40",
    label: "Unknown",
  },
};

const formatDateShort = (ms: number): string => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toLocaleString("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
    .replace("AM", "am")
    .replace("PM", "pm");
};

const columns = [
  col.accessor("direction", {
    id: "direction",
    header: "DIRECTION",
    enableSorting: true,
    cell: (info) => (
      <span className="font-medium text-grey-20 dark:text-grey-dark-200">
        {directionLabel(info.getValue())}
      </span>
    ),
  }),
  col.accessor((row) => row, {
    id: "amount",
    header: "AMOUNT",
    enableSorting: false,
    cell: (info) => {
      const row = info.getValue();
      const symbol = row.direction === "halpha-to-alpha" ? "hALPHA" : "ALPHA";
      return (
        <span className="font-medium text-grey-20 dark:text-grey-dark-200">
          {formatBridgeAmount(row.amount, row.amountDecimals)} {symbol}
        </span>
      );
    },
  }),
  col.accessor("status", {
    id: "status",
    header: "STATUS",
    enableSorting: true,
    cell: (info) => {
      const s = statusStyles[info.getValue()] ?? statusStyles.unknown;
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", s.dot)} />
          <span className={cn("text-[13px] font-medium", s.text)}>
            {s.label}
          </span>
        </span>
      );
    },
  }),
  col.accessor("recipientAddress", {
    id: "recipient",
    header: "RECIPIENT",
    enableSorting: false,
    cell: (info) => (
      <CopyableCell
        copyAbleText={info.getValue() ?? ""}
        title="Copy recipient"
        toastMessage="Recipient address copied"
        textColor="text-grey-20 dark:text-grey-dark-200"
        isTable
      />
    ),
  }),
  col.accessor("sourceTxHash", {
    id: "txHash",
    header: "TX HASH",
    enableSorting: false,
    cell: (info) => {
      const hash = info.getValue();
      if (!hash) {
        return <span className="text-grey-40">—</span>;
      }
      return (
        <CopyableCell
          copyAbleText={hash}
          title="Copy transaction hash"
          toastMessage="Transaction hash copied"
          textColor="text-grey-20 dark:text-grey-dark-200"
          isTable
        />
      );
    },
  }),
  col.accessor("createdAt", {
    id: "createdAt",
    header: "DATE",
    enableSorting: true,
    cell: (info) => (
      <span className="font-medium text-grey-dark-800 dark:text-grey-dark-800">
        {formatDateShort(info.getValue())}
      </span>
    ),
  }),
];

const BridgeTransactionHistoryTable: React.FC = () => {
  const { transactions, transactionsLoading } = useBridge();
  const [page, setPage] = useState(1);
  const pageSize = DEFAULT_PAGE_SIZE;

  const sortedData = useMemo(
    () => transactions.slice().sort((a, b) => b.createdAt - a.createdAt),
    [transactions],
  );

  const totalCount = sortedData.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const pageData = useMemo(
    () => sortedData.slice((page - 1) * pageSize, page * pageSize),
    [sortedData, page, pageSize],
  );

  const table = useReactTable({
    columns,
    data: pageData,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (transactionsLoading) {
    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className={MIN_W}>
            <THead>
              <Tr>
                {HEADERS.map((h) => (
                  <th
                    key={h}
                    className="h-[var(--table-row-height,36px)] border-b border-r border-[#E3E3E3] bg-white px-[var(--table-cell-padding-x,10px)] py-0 text-left text-[length:var(--table-header-font-size,10px)] font-semibold uppercase text-grey-dark-600 last:border-r-0 dark:border-[#313131] dark:!bg-[#111111] dark:text-grey-dark-700"
                  >
                    {h}
                  </th>
                ))}
              </Tr>
            </THead>
            <TBody>
              <SkeletonTableRow
                rows={DEFAULT_PAGE_SIZE}
                columns={HEADERS.length}
                columnWidths={SKEL_WIDTHS}
                rowClassName="odd:bg-[#fbfbfb] even:bg-[#f5f5f5] dark:odd:bg-[#161616] dark:even:bg-[#1e1e1e]"
                cellClassName="!border-[#E3E3E3] dark:!border-[#313131]"
              />
            </TBody>
          </Table>
        </div>
      </TableWrapper>
    );
  }

  if (totalCount === 0) {
    return (
      <div className="p-3">
        <NoEntriesFound
          title="No bridge transactions yet"
          description="Bridges you submit from the Bridge Tokens action will appear here."
          cardView={false}
          className="p-6 sm:p-10 rounded-[8px]"
        />
      </div>
    );
  }

  return (
    <>
      {totalCount > DEFAULT_PAGE_SIZE && (
        <div className="flex justify-end px-3 pt-3 mb-3">
          <MiniPaginationControl
            currentPage={page}
            totalPages={totalPages}
            pageSize={pageSize}
            totalCount={totalCount}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          />
        </div>
      )}

      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className={MIN_W}>
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

      {totalCount > DEFAULT_PAGE_SIZE && (
        <div className="px-3 pb-3 mt-3">
          <Pagination
            currentPage={page}
            totalPages={totalPages}
            setPage={setPage}
            totalCount={totalCount}
            pageSize={pageSize}
          />
        </div>
      )}
    </>
  );
};

export default BridgeTransactionHistoryTable;
