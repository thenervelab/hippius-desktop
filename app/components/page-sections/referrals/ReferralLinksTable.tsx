"use client";

import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
import NoEntriesFound from "@/components/ui/NoEntriesFound";

import {
  useReferralLinks,
  type ReferralLink,
} from "@/lib/hooks/api/useReferralLinks";
import { REFERRAL_CODE_CONFIG } from "@/lib/config";
import { cn } from "@/lib/utils";

/* "Your Referral Links" table.
 *
 * Restyled to mirror BillingnHistoryTable / TransactionHistoryTable:
 * the same Th/Td primitives, the same #E3E3E3 / #313131 border palette,
 * banded #fbfbfb / #f5f5f5 (light) and #161616 / #1e1e1e (dark) row
 * fills, SkeletonTableRow on load, NoEntriesFound empty state, and the
 * MiniPaginationControl-in-header / full-Pagination-below pair. */

const columnHelper = createColumnHelper<ReferralLink>();
const DEFAULT_PAGE_SIZE = 10;

const HEADERS = ["LINK", "AMOUNT (hALPHA)", ""];
const SKELETON_WIDTHS = ["70%", "100px", "40px"];
const MIN_W = "min-w-[560px]";

interface ReferralLinksTableProps {
  headerPortalTarget?: HTMLElement | null;
  devData?: ReferralLink[];
  onGenerate?: () => void;
  isGenerating?: boolean;
  isRefreshing?: boolean;
}

const ReferralLinksTable: React.FC<ReferralLinksTableProps> = ({
  headerPortalTarget,
  devData,
  onGenerate,
  isGenerating = false,
  isRefreshing = false,
}) => {
  const { links: realLinks, loading: realLoading } = useReferralLinks();

  /* devData (from the page-level Dev Tools panel) overrides the live
   * hook so we can stress-test the layout with N rows without touching
   * chain state. */
  const links = devData ?? realLinks;
  const loading = devData ? false : realLoading || isRefreshing;

  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const totalCount = links.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pageData = useMemo(
    () => links.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    [links, pageIndex, pageSize],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor("code", {
        header: "LINK",
        meta: {
          headerClassName: "min-w-[380px]",
          cellClassName: "min-w-[380px]",
        },
        cell: ({ getValue }) => {
          const fullReferralCode = `${REFERRAL_CODE_CONFIG.link}${getValue()}`;
          return (
            <span className="font-medium text-grey-20 dark:text-grey-dark-200">
              <span className="hidden lg:inline">{fullReferralCode}</span>
              <span className="lg:hidden">
                {fullReferralCode.slice(0, 5)}…
                {fullReferralCode.slice(fullReferralCode.length - 6)}
              </span>
            </span>
          );
        },
      }),
      columnHelper.accessor("reward", {
        header: () => (
          <span>
            AMOUNT (<span className="!normal-case">hALPHA</span>)
          </span>
        ),
        cell: (info) => (
          <span className="font-medium text-grey-20 dark:text-grey-dark-200">
            {info.getValue()}
          </span>
        ),
        meta: {
          headerClassName: "w-[140px]",
          cellClassName: "w-[140px]",
        },
      }),
      columnHelper.display({
        id: "copy",
        header: "",
        cell: ({ row }) => {
          const code = row.original.code;
          const url = `${REFERRAL_CODE_CONFIG.link}${code}`;
          return (
            <CopyableCell
              title="Copy Referral Code"
              toastMessage="Referral Code Copied Successfully!"
              copyAbleText={url}
              showCopyAbleText={false}
            />
          );
        },
        meta: {
          headerClassName: "w-[60px]",
          cellClassName: "w-[60px]",
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

  if (loading) {
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
                columnWidths={SKELETON_WIDTHS}
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
          title="No referral links yet"
          description="Your referral links will appear here once generated."
          buttonText="+ Generate Referral Link"
          onButtonClick={onGenerate}
          isLoading={isGenerating}
          cardView={false}
          className="p-6 sm:p-10 rounded-[8px]"
        />
      </div>
    );
  }

  const showPagination = totalCount > DEFAULT_PAGE_SIZE;

  const miniPaginationEl = showPagination ? (
    <MiniPaginationControl
      currentPage={pageIndex + 1}
      totalPages={totalPages}
      pageSize={pageSize}
      totalCount={totalCount}
      onPrev={() => setPageIndex((p) => Math.max(0, p - 1))}
      onNext={() => setPageIndex((p) => Math.min(totalPages - 1, p + 1))}
    />
  ) : null;

  return (
    <>
      {headerPortalTarget && miniPaginationEl
        ? createPortal(miniPaginationEl, headerPortalTarget)
        : null}

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

      {showPagination && (
        <div className="px-3 pb-3 mt-3">
          <Pagination
            currentPage={pageIndex + 1}
            totalPages={totalPages}
            setPage={(p) => setPageIndex(p - 1)}
            totalCount={totalCount}
            pageSize={pageSize}
            setPageSize={(s) => {
              setPageSize(s);
              setPageIndex(0);
            }}
          />
        </div>
      )}
    </>
  );
};

export default ReferralLinksTable;
