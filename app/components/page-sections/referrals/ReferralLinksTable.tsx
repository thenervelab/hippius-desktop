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

/* "Your Referral Links" table — ported from hippius-web. Reads the
 * desktop's existing IPC-backed useReferralLinks hook (same row shape
 * as web's), then renders the LINK / AMOUNT / COPY column set with
 * full pagination support. */

const columnHelper = createColumnHelper<ReferralLink>();
const DEFAULT_PAGE_SIZE = 10;

const HEADERS = ["LINK", "hALPHA EARNED", ""];
const SKELETON_WIDTHS = ["70%", "80px", "40px"];

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
            <>
              <div className="hidden lg:block">{fullReferralCode}</div>
              <div className="lg:hidden max-w-[150px]">
                {fullReferralCode.slice(0, 5)}…
                {fullReferralCode.slice(fullReferralCode.length - 6)}
              </div>
            </>
          );
        },
      }),
      columnHelper.accessor("reward", {
        header: () => (
          <span>
            AMOUNT (<span className="!normal-case">hALPHA</span>)
          </span>
        ),
        cell: (info) => info.getValue(),
        meta: {
          headerClassName: "w-[130px]",
          cellClassName: "w-[130px]",
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
        <Table>
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
      </TableWrapper>
    );
  }

  if (totalCount === 0) {
    return (
      <NoEntriesFound
        title="No referral links yet"
        description="Your referral links will appear here once generated."
        buttonText="+ Generate Referral Link"
        onButtonClick={onGenerate}
        isLoading={isGenerating}
      />
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
          <Table>
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
            currentPage={pageIndex + 1}
            totalPages={totalPages}
            setPage={(p) => setPageIndex(p - 1)}
            totalCount={totalCount}
            pageSize={pageSize}
            setPageSize={setPageSize}
          />
        </div>
      )}
    </>
  );
};

export default ReferralLinksTable;
