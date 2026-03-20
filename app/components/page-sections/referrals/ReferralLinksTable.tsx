"use client";

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { Loader2 } from "lucide-react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable
} from "@tanstack/react-table";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { P } from "@/components/ui/typography";
import {
  TableWrapper,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Pagination,
  CopyableCell
} from "@/components/ui/alt-table";

import { REFERRAL_CODE_CONFIG } from "@/lib/config";
import {
  ReferralLink
} from "@/app/lib/hooks/api/useReferralLinks";
import { Link } from "@/components/ui/icons";

const columnHelper = createColumnHelper<ReferralLink>();

// Column order for referral links table
const COLUMN_ORDER = ["code", "reward", "copy"] as const;

// Default column widths for referral links table (percentages)
const DEFAULT_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  code: 60,
  reward: 30,
  copy: 10,
};

const MIN_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  code: 40,
  reward: 20,
  copy: 5,
};

const normalizeColumnWidths = (maybeStored?: Record<string, number>) => {
  const merged: Record<string, number> = { ...DEFAULT_COLUMN_WIDTHS, ...(maybeStored || {}) };
  const normalized: Record<string, number> = {};

  // Keep only expected keys with numeric values; fall back to defaults
  COLUMN_ORDER.forEach((key) => {
    const v = Number(merged[key]);
    normalized[key] = Number.isFinite(v) ? v : DEFAULT_COLUMN_WIDTHS[key];
  });

  // Keep total ≈ 100%
  const total = COLUMN_ORDER.reduce((acc, k) => acc + normalized[k], 0);
  if (total !== 100) {
    const factor = 100 / total;
    COLUMN_ORDER.forEach((k) => {
      normalized[k] = Math.round(normalized[k] * factor * 100) / 100;
    });
  }
  return normalized as Record<string, number>;
};

const getStoredColumnWidths = () => {
  if (typeof window === "undefined") return normalizeColumnWidths();
  try {
    const stored = localStorage.getItem("referralTable_columnWidths");
    return normalizeColumnWidths(stored ? JSON.parse(stored) : undefined);
  } catch {
    return normalizeColumnWidths();
  }
};

const saveColumnWidths = (columnWidths: Record<string, number>) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("referralTable_columnWidths", JSON.stringify(columnWidths));
  } catch { }
};

export default function ReferralLinksTable() {
  // Feature disabled - use static empty data to prevent app hanging
  // The useReferralLinks hook depends on mnemonic which may not be available
  const links: ReferralLink[] = [];
  const loading = false;
  // pagination setup
  const pageSize = 10;
  const [pageIndex, setPageIndex] = useState(0);
  const totalPages = Math.ceil(links.length / pageSize);
  const pageData = useMemo(
    () => links.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageIndex]
  );

  // Column resizing state
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => getStoredColumnWidths()
  );
  const [isResizing, setIsResizing] = useState(false);
  const [resizeData, setResizeData] = useState<{
    columnId: string;
    startX: number;
    startWidth: number;
    nextColumnId?: string;
    nextStartWidth: number;
  } | null>(null);

  // Save column widths to localStorage
  useEffect(() => {
    saveColumnWidths(columnWidths);
  }, [columnWidths]);

  // Real visible order derived from the columns
  const visibleColumnOrder = useMemo<string[]>(
    () => ["code", "reward", "copy"],
    []
  );

  // Column resize handlers
  const handleResizeStart = useCallback(
    (columnId: string, startX: number) => {
      const columnIds = visibleColumnOrder;
      const currentIndex = columnIds.indexOf(columnId);
      if (currentIndex === -1) return;

      const nextColumnId = columnIds[currentIndex + 1] ?? columnIds[currentIndex - 1];
      if (!nextColumnId) return;

      setIsResizing(true);
      setResizeData({
        columnId,
        startX,
        startWidth:
          columnWidths[columnId] ?? DEFAULT_COLUMN_WIDTHS[columnId as (typeof COLUMN_ORDER)[number]],
        nextColumnId,
        nextStartWidth:
          columnWidths[nextColumnId] ??
          DEFAULT_COLUMN_WIDTHS[nextColumnId as (typeof COLUMN_ORDER)[number]],
      });
    },
    [columnWidths, visibleColumnOrder]
  );

  const handleResizeMove = useCallback(
    (clientX: number) => {
      if (!resizeData || !isResizing) return;

      requestAnimationFrame(() => {
        const diff = clientX - resizeData.startX;
        const tableWidth = 1200;
        const sensitivity = 2.2;
        const diffPercent = (diff / tableWidth) * 100 * sensitivity;

        // push/pull against the neighbor (right by default)
        const proposedCurrentWidth = resizeData.startWidth + diffPercent;
        const proposedNextWidth = resizeData.nextStartWidth - diffPercent;

        const currentMin =
          MIN_COLUMN_WIDTHS[resizeData.columnId as (typeof COLUMN_ORDER)[number]] ?? 5;
        const nextMin =
          MIN_COLUMN_WIDTHS[resizeData.nextColumnId as (typeof COLUMN_ORDER)[number]] ?? 5;

        const newCurrent = Math.max(currentMin, Math.min(80, proposedCurrentWidth));
        const newNext = Math.max(nextMin, Math.min(80, proposedNextWidth));

        if (newCurrent >= currentMin && newNext >= nextMin && resizeData.nextColumnId) {
          setColumnWidths((prev) => {
            const updated = {
              ...prev,
              [resizeData.columnId]: newCurrent,
              [resizeData.nextColumnId!]: newNext,
            };
            // Normalize to keep total at 100%
            const total = COLUMN_ORDER.reduce((sum, key) => sum + updated[key], 0);
            if (total !== 100) {
              const factor = 100 / total;
              COLUMN_ORDER.forEach(key => {
                updated[key] = Math.round(updated[key] * factor * 100) / 100;
              });
            }
            return updated;
          });
        }
      });
    },
    [resizeData, isResizing]
  );

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    setResizeData(null);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => handleResizeMove(e.clientX);
    const handleMouseUp = () => handleResizeEnd();

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("code", {
        header: "Link",
        cell: ({ getValue }) => {
          const fullReferralCode = `${REFERRAL_CODE_CONFIG.link}${getValue()}`;
          return (
            <>
              <div className="hidden lg:block">{fullReferralCode}</div>
              <div className="lg:hidden max-w-[150px]">
                {fullReferralCode.slice(0, 5)}...
                {fullReferralCode.slice(fullReferralCode.length - 6)}
              </div>
            </>
          );
        }
      }),
      columnHelper.accessor("reward", {
        header: "hALPHA EARNED",
        cell: (info) => `${info.getValue()} hAlpha`
      }),
      columnHelper.display({
        id: "copy",
        header: "",
        cell: ({ row }) => {
          const code = row.original.code;
          const url = `${REFERRAL_CODE_CONFIG.link}${code}`;
          return (
            <div className="w-full flex justify-center">
              <CopyableCell
                className="justify-center"
                buttonClass="!text-grey-70"
                title="Copy Referral Code"
                toastMessage="Referral Code Copied Successfully!"
                copyAbleText={url}
                showCopyAbleText={false}
                isJustifyCenter={true}
              />
            </div>
          );
        }
      })
    ],
    []
  );

  const table = useReactTable({
    data: pageData,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <div className="mb-4">
      <div className="flex items-center gap-x-2 mb-4">
        <AbstractIconWrapper className="size-10">
          <Link className="absolute size-6 text-primary-50" />
        </AbstractIconWrapper>
        <P size="lg">Your Referral Links</P>
      </div>

      <TableWrapper className="overflow-x-hidden">
        {loading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="animate-spin text-grey-60 size-8" />
          </div>
        ) : table.getRowModel().rows.length === 0 ? (
          <div className="p-6 text-center text-grey-60">
            No referral links yet
          </div>
        ) : (
          <>
            <Table className="w-full">
              <THead>
                {table.getHeaderGroups().map((hg) => (
                  <Tr key={hg.id}>
                    {hg.headers.map((h) => (
                      <Th key={h.id} header={h} onResizeStart={handleResizeStart} />
                    ))}
                  </Tr>
                ))}
              </THead>
              <TBody>
                {table.getRowModel().rows.map((row) => (
                  <Tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <Td className="text-grey-20" key={cell.id} cell={cell} columnWidth={columnWidths[cell.column.id]} />
                    ))}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </>
        )}
      </TableWrapper>
      {totalPages > 1 && (
        <Pagination
          className="mt-5"
          currentPage={pageIndex + 1}
          totalPages={totalPages}
          setPage={(p) => setPageIndex(p - 1)}
        />
      )}
    </div>
  );
}
