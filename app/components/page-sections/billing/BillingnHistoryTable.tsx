import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  TableWrapper,
  Table,
  Tr,
  Td,
  Th,
  THead,
  TBody,
  Pagination,
  CopyableCell,
} from "@/components/ui/alt-table";
import { Loader2 } from "lucide-react";
import AbstractIconWrapper from "@/components/ui/abstract-icon-wrapper";
import { Dollar, TaoLogo } from "@/components/ui/icons";
import TransactionTypeBadge from "./TransactionTypeBadge";
import useBillingTransactions, {
  TransactionObject,
} from "@/app/lib/hooks/api/useBillingTransactions";
import StatusTypeBadge from "./StatusTypeBadge";
import { cn } from "@/app/lib/utils";

export const formatDate = (
  date: Date,
  variant: "long" | "short" = "long"
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

const columnHelper = createColumnHelper<TransactionObject>();
const ITEMS_PER_PAGE = 10;

// Visible column order (single source of truth)
const COLUMN_ORDER = ["id", "amount", "transaction_type", "status", "date"] as const;

// Default column widths for billing history table (percentages)
const DEFAULT_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  id: 25,
  amount: 15,
  transaction_type: 20,
  status: 15,
  date: 25,
};

const MIN_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  id: 25,
  amount: 20,
  transaction_type: 20,
  status: 15,
  date: 20,
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
    const stored = localStorage.getItem("billingTable_columnWidths");
    return normalizeColumnWidths(stored ? JSON.parse(stored) : undefined);
  } catch {
    return normalizeColumnWidths();
  }
};

const saveColumnWidths = (columnWidths: Record<string, number>) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("billingTable_columnWidths", JSON.stringify(columnWidths));
  } catch { }
};

const BillingHistoryTable: React.FC = () => {
  const { data: transactions, isPending, error } = useBillingTransactions();

  const tableRef = useRef<HTMLDivElement>(null);

  const [currentPage, setCurrentPage] = useState(1);

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
  const [justResized, setJustResized] = useState(false);

  // Save column widths to localStorage (debounced)
  useEffect(() => {
    saveColumnWidths(columnWidths);
  }, [columnWidths]);

  const baseColumns = useMemo(
    () => [
      columnHelper.accessor("id", {
        id: "id",
        header: "ID",
        cell: (info) => (
          <CopyableCell
            copyAbleText={String(info.getValue())}
            title="Copy Billing ID"
            toastMessage="Billing ID Copied Successfully!"
            isTable={true}
          />
        ),
        enableSorting: true,
      }),
      columnHelper.accessor("amount", {
        id: "amount",
        header: "AMOUNT",
        cell: (d) => {
          return (
            <div className="flex items-center gap-x-1">
              {d.row.original.transaction_type === "tao" ? (
                <TaoLogo className="size-2.5" />
              ) : (
                "$"
              )}
              <span>{d.getValue().toLocaleString()}</span>
            </div>
          );
        },
        enableSorting: true,
      }),
      columnHelper.accessor("transaction_type", {
        id: "transaction_type",
        header: "TRANSACTION TYPE",
        cell: (d) => {
          const type = d.getValue();
          const validType = type === "tao" || type === "card" ? type : null;
          return <TransactionTypeBadge type={validType} />;
        },
      }),
      columnHelper.accessor("status", {
        id: "status",
        header: "STATUS",
        cell: (d) => {
          const status = d.getValue();
          const validStatus =
            status === "failed" ||
              status === "success" ||
              status === "completed" ||
              status === "pending"
              ? status
              : null;
          return <StatusTypeBadge type={validStatus} />;
        },
      }),
      columnHelper.accessor("transaction_date", {
        id: "date",
        header: "TRANSACTION DATE",
        minSize: 200,
        maxSize: 1000,
        cell: (d) => formatDate(new Date(d.getValue())),
        enableSorting: true,
      }),
    ],
    []
  );

  // Real visible order derived from the columns (never drifts)
  const visibleColumnOrder = useMemo<string[]>(
    () => baseColumns.map((c) => c.id!),
    [baseColumns]
  );

  // Column resize handlers (use visible order)
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
        const tableWidth = tableRef.current?.getBoundingClientRect().width || 1200;
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
    setJustResized(true);
    setTimeout(() => {
      setJustResized(false);
    }, 100);
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

  const totalPages = useMemo(
    () => Math.ceil((transactions?.length || 0) / ITEMS_PER_PAGE),
    [transactions?.length]
  );

  const paginatedData = useMemo(() => {
    if (!transactions) return [];
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return transactions.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [transactions, currentPage]);

  const columns = baseColumns;

  const table = useReactTable({
    columns,
    data: paginatedData,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <>
      <TableWrapper
        className={cn(
          "mt-5 overflow-x-hidden"
        )}
      >
        <div ref={tableRef}>
          <Table>
            <THead>
              {table.getHeaderGroups().map((hg) => (
                <Tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <Th
                      key={h.id}
                      header={h}
                      columnWidth={columnWidths[h.id]}
                      onResizeStart={handleResizeStart}
                      preventSort={justResized}
                    />
                  ))}
                </Tr>
              ))}
            </THead>
            <TBody>
              {table.getRowModel().rows.map((row) => (
                <Tr key={row.id} transparent>
                  {row.getVisibleCells().map((cell) => (
                    <Td
                      className="text-grey-20"
                      key={cell.id}
                      cell={cell}
                      columnWidth={columnWidths[cell.column.id]}
                    />
                  ))}
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>

        {isPending && !error && (
          <div className="w-full h-[21.875rem] flex items-center justify-center p-6 animate-fade-in-0.3">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}

        {((transactions && !transactions.length) || error) &&
          !isPending &&
          transactions !== null && (
            <div className="w-full h-[21.875rem] flex items-center justify-center p-6">
              <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
                <AbstractIconWrapper className="size-10 rounded-2xl bg-grey-40/20 mb-2">
                  <Dollar className="absolute size-6" />
                </AbstractIconWrapper>
                <span className="text-grey-60 text-sm font-medium max-w-[16.25rem] text-center">
                  {error
                    ? `Unable to load billing history: ${error}`
                    : "You do not have any billing history yet"}
                </span>
              </div>
            </div>
          )}
      </TableWrapper>

      {totalPages > 1 && (
        <div className="my-4">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            setPage={setCurrentPage}
          />
        </div>
      )}
    </>
  );
};

export default BillingHistoryTable;
