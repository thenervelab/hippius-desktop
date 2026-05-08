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
import StatusTypeBadge from "./StatusTypeBadge";
import TransactionTypeBadge from "./TransactionTypeBadge";
import useBillingTransactions, {
  TransactionObject,
} from "@/app/lib/hooks/api/useBillingTransactions";
import { CopyableCell } from "@/components/ui/alt-table";
import { TaoLogo, Dollar } from "@/components/ui/icons";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";

const HEADERS = ["ID", "AMOUNT", "TRANSACTION TYPE", "STATUS", "DATE"];
const SKEL_WIDTHS = ["120px", "80px", "120px", "90px", "150px"];
const MIN_W = "min-w-[540px] sm:min-w-[780px]";
const DEFAULT_PAGE_SIZE = 10;

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

const col = createColumnHelper<TransactionObject>();

const columns = [
  col.accessor("id", {
    header: "ID",
    cell: (d) => (
      <CopyableCell
        copyAbleText={String(d.getValue())}
        title="Copy Billing ID"
        toastMessage="Billing ID Copied Successfully!"
        isTable={true}
        textColor="text-grey-20 dark:text-grey-dark-200"
        copyIconClassName="size-3.5 text-grey-60 dark:text-grey-dark-500"
      />
    ),
  }),
  col.accessor("amount", {
    header: "AMOUNT",
    enableSorting: true,
    cell: (d) => (
      <div className="flex items-center gap-x-1 font-medium text-grey-20 dark:text-grey-dark-200">
        {d.row.original.transaction_type === "tao" ? (
          <TaoLogo className="size-2.5" />
        ) : (
          "$"
        )}
        <span>{d.getValue().toLocaleString()}</span>
      </div>
    ),
  }),
  col.accessor("transaction_type", {
    header: "TRANSACTION TYPE",
    cell: (d) => {
      const type = d.getValue();
      const validType = type === "tao" || type === "card" ? type : null;
      return <TransactionTypeBadge type={validType} />;
    },
  }),
  col.accessor("status", {
    header: "STATUS",
    cell: (d) => {
      const raw = d.getValue();
      if (!raw) return null;
      const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
      const validStatuses = [
        "failed", "error", "declined", "cancelled", "canceled", "expired",
        "success", "successful", "completed", "paid", "confirmed",
        "pending", "processing", "in_progress", "refunded", "reversed",
      ] as const;
      const validStatus = validStatuses.find((s) => s === normalized) ?? null;
      return <StatusTypeBadge type={validStatus} fallback={raw} />;
    },
  }),
  col.accessor("transaction_date", {
    header: "DATE",
    enableSorting: true,
    cell: (d) => (
      <span className="font-medium text-grey-dark-800 dark:text-grey-dark-800">
        {formatDate(new Date(d.getValue()))}
      </span>
    ),
  }),
];

const BillingHistoryTable: React.FC = () => {
  const { data: transactions, isPending, error } = useBillingTransactions();

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

  // Loading state
  if (isPending && !error) {
    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className={`overflow-x-auto custom-scrollbar-thin`}>
          <Table className={MIN_W}>
            <THead>
              <Tr className="bg-[#fefefe] dark:bg-black-500">
                {HEADERS.map((h) => (
                  <th
                    key={h}
                    className="h-[var(--table-row-height,36px)] border-b border-r border-grey-dark-100 px-[var(--table-cell-padding-x,10px)] py-0 text-left text-[length:var(--table-header-font-size,10px)] font-semibold uppercase text-grey-dark-600 last:border-r-0 dark:border-black-300 dark:text-grey-dark-700"
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
              />
            </TBody>
          </Table>
        </div>
      </TableWrapper>
    );
  }

  // Empty / error state
  if (((transactions && !transactions.length) || error) && !isPending) {
    const errorMessage = (() => {
      if (!error) return null;
      if (error instanceof Error) return error.message;
      if (typeof error === "string") return error;
      if (typeof error === "object" && "message" in error)
        return String((error as { message: unknown }).message);
      return "Unexpected error";
    })();

    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="flex h-[21.875rem] w-full items-center justify-center p-6">
          <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
            <AbstractIconWrapper className="size-10 rounded-2xl bg-grey-40/20 mb-2">
              <Dollar className="absolute size-6" />
            </AbstractIconWrapper>
            <span className="text-grey-60 text-sm font-medium max-w-[16.25rem] text-center">
              {errorMessage
                ? `Unable to load billing history: ${errorMessage}`
                : "You do not have any billing history yet"}
            </span>
          </div>
        </div>
      </TableWrapper>
    );
  }

  return (
    <>
      {/* Mini pagination in header — only when multiple pages */}
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
                <Tr key={hg.id} className="bg-[#fefefe] dark:bg-black-primary-bg">
                  {hg.headers.map((h) => (
                    <Th key={h.id} header={h} />
                  ))}
                </Tr>
              ))}
            </THead>
            <TBody>
              {table.getRowModel().rows.map((row) => (
                <Tr key={row.id} className="bg-white dark:bg-transparent">
                  {row.getVisibleCells().map((cell) => (
                    <Td key={cell.id} cell={cell} />
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

export default BillingHistoryTable;
