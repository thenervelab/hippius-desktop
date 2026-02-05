import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { P } from "@/components/ui/typography";
import { AlertCircle, Hourglass, Loader2, Send } from "lucide-react";
import {
  TableWrapper,
  Table,
  Tr,
  Td,
  Th,
  THead,
  TBody,
} from "@/components/ui/alt-table";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import {
  ReferralEvent,
} from "@/app/lib/hooks/api/useUserReferrals";
import { useAtomValue } from "jotai";
import { isUnpinnedDialogOpenAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { cn } from "@/app/lib/utils";
import { useState, useMemo, useCallback, useEffect } from "react";

const columnHelper = createColumnHelper<ReferralEvent>();

// Column order for referral history table
const COLUMN_ORDER = ["address", "reward", "date", "status"] as const;

// Default column widths for referral history table (percentages)
const DEFAULT_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  address: 40,
  reward: 25,
  date: 20,
  status: 15,
};

const MIN_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  address: 30,
  reward: 20,
  date: 15,
  status: 10,
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
    const stored = localStorage.getItem("referralHistoryTable_columnWidths");
    return normalizeColumnWidths(stored ? JSON.parse(stored) : undefined);
  } catch {
    return normalizeColumnWidths();
  }
};

const saveColumnWidths = (columnWidths: Record<string, number>) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("referralHistoryTable_columnWidths", JSON.stringify(columnWidths));
  } catch { }
};

const ReferralHistoryTable: React.FC = () => {
  // Feature disabled - use static empty data to prevent app hanging
  // The useUserReferrals hook depends on mnemonic which may not be available
  const data = { referralHistory: [] as ReferralEvent[], totalReferrals: 0, totalRewards: "0", referralCodes: [] };
  const isPending = false;
  const isError = false;
  const isUnpinnedOpen = useAtomValue(isUnpinnedDialogOpenAtom);

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
    () => ["address", "reward", "date", "status"],
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
  const columns = [
    columnHelper.accessor("address", {
      header: "ADDRESS",
      cell: (d) => `$ ${d.getValue().toLocaleString()}`,
      enableSorting: false,
    }),
    columnHelper.accessor("reward", {
      header: "REWARD",
      enableSorting: true,
    }),
    columnHelper.accessor("date", {
      header: "DATE",
      enableSorting: true,
    }),
    columnHelper.accessor("status", {
      header: "STATUS",
      enableSorting: true,
    }),
  ];

  const table = useReactTable({
    columns,
    data: data?.referralHistory || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div
      className={cn(
        isUnpinnedOpen &&
        data &&
        data.referralHistory &&
        data.referralHistory.length > 0 &&
        "mb-[90px]"
      )}
    >
      <div className="flex items-center gap-x-2 mb-4">
        <AbstractIconWrapper className="size-10">
          <Hourglass className="absolute size-6 text-primary-50" />
        </AbstractIconWrapper>
        <P size="lg">Referral History</P>
      </div>
      {/* <TransactionHistory /> */}

      <TableWrapper className="mt-5 overflow-x-hidden">
        <Table>
          <THead>
            {table.getHeaderGroups().map((headerGroup) => (
              <Tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Th key={header.id} header={header} onResizeStart={handleResizeStart} />
                ))}
              </Tr>
            ))}
          </THead>

          <TBody>
            {table.getRowModel().rows?.map((row) => {
              return (
                <Tr key={row.id} transparent>
                  {row.getVisibleCells().map((cell) => (
                    <Td className="text-grey-20" key={cell.id} cell={cell} columnWidth={columnWidths[cell.column.id]} />
                  ))}
                </Tr>
              );
            })}
          </TBody>
        </Table>
        {isError && !data && (
          <div className="p-6 w-full h-[350px] flex items-center justify-center">
            <div className="flex flex-col animate-fade-in-0.5 items-center opacity-0">
              <AbstractIconWrapper className="size-10 rounded-2xl flex items-center justify-center bg-grey-40/20 mb-2">
                <AlertCircle className="absolute size-6 text-red-400" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[190px] text-center">
                Failed to get data
              </span>
            </div>
          </div>
        )}
        {isPending && (
          <div className="w-full animate-fade-in-0.3 opacity-0 h-[350px] flex items-center justify-center p-6">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}
        {data && !data.referralHistory.length && (
          <div className="w-full h-[350px] flex items-center justify-center p-6">
            <div className="flex flex-col animate-fade-in-0.5 items-center opacity-0">
              <AbstractIconWrapper className="size-10 rounded-2xl flex items-center justify-center bg-grey-40/20 mb-2">
                <Send className="absolute size-6 text-primary-50" />
              </AbstractIconWrapper>
              <span className="text-grey-60 text-sm font-medium max-w-[190px] text-center">
                You have not made any referrals yet
              </span>
            </div>
          </div>
        )}
      </TableWrapper>
    </div>
  );
};

export default ReferralHistoryTable;
