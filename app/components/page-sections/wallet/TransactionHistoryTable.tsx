"use client";

import React, { useMemo, useState } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableWrapper,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Pagination,
  MiniPaginationControl,
  SkeletonTableRow,
} from "@/components/ui/table";
import { CopyableCell } from "@/components/ui/alt-table";
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import { cn } from "@/lib/utils";
import { TransactionObject } from "@/app/lib/hooks/api/useBalanceTransactions";

/* Transaction History tab.
 *
 * Restyled to mirror BillingnHistoryTable: the same Th/Td primitives,
 * the same border + row-alternation palette, SkeletonTableRow on load,
 * AbstractIconWrapper empty state, MiniPaginationControl above + full
 * Pagination below. Functional behavior — sortable columns, copyable
 * FROM/TO cells, page slicing — is preserved. */

export const formatDate = (
  date: Date,
  variant: "long" | "short" = "long",
): string => {
  if (variant === "long") {
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
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .replace(",", "")
    .toLowerCase();
};

const HEADERS = [
  "BLOCK",
  "AMOUNT (hALPHA)",
  "FROM",
  "TO",
  "TRANSACTION TYPE",
  "TRANSACTION DATE",
];
const SKEL_WIDTHS = ["80px", "100px", "160px", "160px", "100px", "150px"];
const MIN_W = "min-w-[640px] sm:min-w-[900px]";
const DEFAULT_PAGE_SIZE = 10;

const col = createColumnHelper<TransactionObject>();

const columns = [
  col.accessor("block", {
    id: "block",
    header: "BLOCK",
    enableSorting: true,
    cell: (d) => (
      <span className="font-medium text-grey-20 dark:text-grey-dark-200">
        {String(d.getValue())}
      </span>
    ),
  }),
  col.accessor("amountHip", {
    id: "amount",
    enableSorting: true,
    header: () => (
      <span>
        AMOUNT (<span className="!normal-case">hALPHA</span>)
      </span>
    ),
    // amountHip is pre-formatted by Rust planck_to_hip — display
    // directly; round-tripping through Number drops precision.
    cell: (d) => (
      <span className="font-medium text-grey-20 dark:text-grey-dark-200">
        {String(d.getValue())}
      </span>
    ),
  }),
  col.accessor("from", {
    id: "from",
    header: "FROM",
    cell: (info) => (
      <CopyableCell
        copyAbleText={info.getValue()}
        title="Copy Account"
        toastMessage="Account Copied Successfully!"
        textColor="text-grey-20 dark:text-grey-dark-200"
        isTable
      />
    ),
  }),
  col.accessor("to", {
    id: "to",
    header: "TO",
    cell: (info) => (
      <CopyableCell
        copyAbleText={info.getValue()}
        title="Copy Account"
        toastMessage="Account Copied Successfully!"
        textColor="text-grey-20 dark:text-grey-dark-200"
        isTable
      />
    ),
  }),
  col.accessor("direction", {
    id: "transactionType",
    header: "TRANSACTION TYPE",
    cell: (info) => {
      const direction = info.getValue();
      return (
        <span
          className={cn(
            // Em-based padding (0.9em≈10px, 0.36em≈4px at 100%): WKWebView's
            // pageZoom clamps small fonts (~9px floor) on zoom-out, so px
            // padding shrinks away from the text and crams the pill; em
            // tracks the clamped font size at any zoom.
            "inline-flex rounded-full border px-[0.9em] py-[0.36em] text-[11px] font-medium",
            direction === "Sent"
              ? "border-[#FEC134] bg-[#FFF2CC] text-[#E89702] dark:border-[#793902] dark:bg-[#793902] dark:text-[#E89702]"
              : "border-[#6CE9A6] bg-[#DAFBE8] text-[#04C870] dark:border-[#03301E] dark:bg-[#03301E] dark:text-[#6CE9A6]",
          )}
        >
          {direction}
        </span>
      );
    },
  }),
  col.accessor("date", {
    id: "date",
    header: "TRANSACTION DATE",
    enableSorting: true,
    cell: (d) => (
      <span className="font-medium text-grey-dark-800 dark:text-grey-dark-800">
        {formatDate(new Date(String(d.getValue())))}
      </span>
    ),
  }),
];

interface TransactionHistoryTableProps {
  transactions: TransactionObject[] | undefined;
  isPending: boolean;
}

const TransactionHistoryTable: React.FC<TransactionHistoryTableProps> = ({
  transactions,
  isPending,
}) => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const totalCount = transactions?.length ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  const pageData = useMemo(() => {
    if (!transactions) return [];
    return transactions.slice((page - 1) * pageSize, page * pageSize);
  }, [transactions, page, pageSize]);

  const table = useReactTable({
    columns,
    data: pageData,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Loading skeleton
  if (isPending) {
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

  // Empty state — mirrors the Files page empty state via the shared
  // NoEntriesFound primitive. Transactions are read-only (the user
  // can't "create" a transaction directly from this surface), so no
  // CTA — the Send/Receive actions live in WalletBalanceCard above.
  if (transactions && !transactions.length) {
    return (
      <div className="p-3">
        <NoEntriesFound
          title="No transactions yet"
          description="When you send or receive hALPHA on this wallet, the transfers will show up here."
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
            setPageSize={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}
    </>
  );
};

export default TransactionHistoryTable;
