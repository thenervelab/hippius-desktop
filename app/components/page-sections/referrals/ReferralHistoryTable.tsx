"use client";

import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Download } from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
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
import { Button } from "@/components/ui/button";
import NoEntriesFound from "@/components/ui/NoEntriesFound";

import {
  useUserReferrals,
  type ReferralEvent,
} from "@/lib/hooks/api/useUserReferrals";
import { formatDate } from "@/app/lib/utils/formatters/formatDate";

/* "Referral History" table — ported from hippius-web. Renders the
 * USER ID / hAlpha EARNED / DATE CREATED / INVOICE columns, with full
 * pagination, header-portal'd MiniPaginationControl, and a placeholder
 * Download button (invoices aren't fully wired yet).
 *
 * Reads the desktop's IPC-backed useUserReferrals hook — same row
 * shape as web's. The Invoice cell action is intentionally a no-op
 * until the API ships. */

const columnHelper = createColumnHelper<ReferralEvent>();
const DEFAULT_PAGE_SIZE = 10;

const HEADERS = ["USER ID", "CREDIT EARNED", "DATE CREATED", "INVOICE"];
const SKELETON_WIDTHS = ["70%", "80px", "120px", "80px"];

interface ReferralHistoryTableProps {
  headerPortalTarget?: HTMLElement | null;
  devData?: ReferralEvent[];
  isRefreshing?: boolean;
}

const ReferralHistoryTable: React.FC<ReferralHistoryTableProps> = ({
  headerPortalTarget,
  devData,
  isRefreshing = false,
}) => {
  const { data: realData, isPending: realIsPending, isError } =
    useUserReferrals();

  /* devData (from the page-level Dev Tools panel) overrides the live
   * hook so we can stress-test the layout with N rows without touching
   * chain state. */
  const data = devData
    ? {
        referralHistory: devData,
        totalReferrals: devData.length,
        totalRewards: "0",
        referralCodes: [],
      }
    : realData;
  const isPending = devData ? false : realIsPending || isRefreshing;

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const allRows = data?.referralHistory || [];
  const totalCount = allRows.length;
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalCount / pageSize)),
    [totalCount, pageSize],
  );
  const pageData = useMemo(
    () => allRows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [allRows, currentPage, pageSize],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor("address", {
        header: "USER ID",
        cell: (info) => (
          <CopyableCell
            copyAbleText={info.getValue()}
            title="Copy User ID"
            toastMessage="User ID Copied Successfully!"
            textColor="text-grey-20 dark:text-grey-dark-200"
            isTable
          />
        ),
        meta: {
          headerClassName: "min-w-[200px]",
          cellClassName: "min-w-[200px]",
        },
      }),
      columnHelper.accessor("reward", {
        header: "hAlpha Earned",
        cell: (info) => info.getValue(),
        meta: {
          headerClassName: "w-[140px]",
          cellClassName: "w-[140px]",
        },
      }),
      columnHelper.accessor("date", {
        header: "DATE CREATED",
        cell: (d) => {
          const raw = d.getValue();
          const parsed = new Date(raw);
          const formatted = !isNaN(parsed.getTime()) ? formatDate(parsed) : raw;
          return <span className="text-[#7D7D7D]">{formatted}</span>;
        },
      }),
      columnHelper.display({
        id: "invoice",
        header: "INVOICE",
        cell: () => (
          <Button
            variant="primaryLight"
            size="auto"
            className="h-7 px-3 text-[12px] gap-1.5"
          >
            <Download className="size-3.5" />
            Download
          </Button>
        ),
        meta: {
          headerClassName: "w-[140px]",
          cellClassName: "w-[140px]",
        },
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: pageData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (isPending) {
    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className="min-w-[680px]">
            <THead>
              <Tr className="bg-[#fefefe] dark:bg-black-primary-bg">
                {HEADERS.map((h) => (
                  <th
                    key={h}
                    className="h-[var(--table-row-height,36px)] border-b border-r border-[#E3E3E3] bg-white px-[var(--table-cell-padding-x,10px)] py-0 text-left text-[length:var(--table-header-font-size,10px)] leading-[var(--table-header-line-height,14px)] font-semibold uppercase text-grey-dark-600 last:border-r-0 dark:border-[#313131] dark:!bg-[#111111] dark:text-grey-dark-700"
                  >
                    {h}
                  </th>
                ))}
              </Tr>
            </THead>
            <TBody>
              <SkeletonTableRow
                rows={pageSize}
                columns={HEADERS.length}
                columnWidths={SKELETON_WIDTHS}
              />
            </TBody>
          </Table>
        </div>
      </TableWrapper>
    );
  }

  if (isError && !data) {
    return (
      <NoEntriesFound
        title="Failed to load"
        description="Referral history is temporarily unavailable."
      />
    );
  }

  if (totalCount === 0) {
    return (
      <NoEntriesFound
        title="No referrals yet"
        description="You have not made any referrals yet."
      />
    );
  }

  const showPagination = totalCount > DEFAULT_PAGE_SIZE;

  const miniPaginationEl = showPagination ? (
    <MiniPaginationControl
      currentPage={currentPage}
      totalPages={totalPages}
      pageSize={pageSize}
      totalCount={totalCount}
      onPrev={() => setCurrentPage((p) => Math.max(1, p - 1))}
      onNext={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
    />
  ) : null;

  return (
    <>
      {headerPortalTarget && miniPaginationEl
        ? createPortal(miniPaginationEl, headerPortalTarget)
        : null}

      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className="min-w-[680px]">
            <THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <Tr
                  key={headerGroup.id}
                  className="bg-[#fefefe] dark:bg-black-primary-bg"
                >
                  {headerGroup.headers.map((header) => (
                    <Th key={header.id} header={header} />
                  ))}
                </Tr>
              ))}
            </THead>
            <TBody>
              {table.getRowModel().rows.map((row) => (
                <Tr
                  key={row.id}
                  className="bg-white dark:bg-black-600"
                  transparent
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
            totalCount={totalCount}
            pageSize={pageSize}
            setPageSize={setPageSize}
          />
        </div>
      )}
    </>
  );
};

export default ReferralHistoryTable;
