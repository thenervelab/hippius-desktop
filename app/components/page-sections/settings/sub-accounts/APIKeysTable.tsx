"use client";

import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable
} from "@tanstack/react-table";
import {
  TableWrapper,
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  CopyableCell,
  Pagination
} from "@/components/ui/alt-table";
import { Loader2, Lock } from "lucide-react";
import { ApiKey } from "@/app/lib/hooks/api/useApiKeys";
import { Icons } from "@/app/components/ui";
import { ShieldSecurity } from "@/app/components/ui/icons";
import { saveSubAccountSeed } from "@/app/lib/helpers/subAccountSeedsDb";
import { getWalletRecord } from "@/app/lib/helpers/hippiusDesktopDB";
import { hashPasscode } from "@/app/lib/helpers/crypto";
import SeedPasscodeModal from "./SeedPasscodeModal";
import ViewSeedModal from "./ViewSeedModal";
import CustomTooltip from "@/app/components/ui/CustomTooltip";
import { cn } from "@/app/lib/utils";

type Props = {
  subs: ApiKey[];
  loading: boolean;
  onDelete: (addr: string) => void;
  hasSeed: (addr: string) => boolean;
  onSeedUpdated?: () => void;
  isDisabled?: (address: string) => boolean;
};

const columnHelper = createColumnHelper<ApiKey>();
const ITEMS_PER_PAGE = 10;

// Column order for API keys table
const COLUMN_ORDER = ["address", "role", "seed", "actions"] as const;

// Default column widths for API keys table (percentages)
const DEFAULT_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  address: 50,
  role: 25,
  seed: 15,
  actions: 10,
};

const MIN_COLUMN_WIDTHS: Record<(typeof COLUMN_ORDER)[number], number> = {
  address: 35,
  role: 15,
  seed: 10,
  actions: 10,
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
  try {
    const stored = localStorage.getItem("apiKeysTable_columnWidths");
    return normalizeColumnWidths(stored ? JSON.parse(stored) : undefined);
  } catch {
    return normalizeColumnWidths();
  }
};

const saveColumnWidths = (columnWidths: Record<string, number>) => {
  try {
    localStorage.setItem("apiKeysTable_columnWidths", JSON.stringify(columnWidths));
  } catch { }
};

const APIKeysTable: React.FC<Props> = ({
  subs,
  loading,
  onDelete,
  hasSeed,
  onSeedUpdated,
  isDisabled = () => false,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedAddress, setSelectedAddress] = useState("");
  const [isViewSeedModalOpen, setIsViewSeedModalOpen] = useState(false);
  const [isSetSeedModalOpen, setIsSetSeedModalOpen] = useState(false);

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
    () => ["address", "role", "seed", "actions"],
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
  const totalPages = useMemo(
    () => Math.ceil(subs.length / ITEMS_PER_PAGE),
    [subs.length]
  );

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return subs.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [subs, currentPage]);

  const handleViewSeed = (addr: string) => {
    setSelectedAddress(addr);
    setIsViewSeedModalOpen(true);
  };

  const handleSetSeed = (addr: string) => {
    setSelectedAddress(addr);
    setIsSetSeedModalOpen(true);
  };

  const handleSetSeedSubmit = async ({
    seed,
    passcode
  }: {
    seed?: string;
    passcode: string;
  }) => {
    try {
      if (!seed) {
        return { success: false, error: "Seed phrase is required" };
      }

      const walletRecord = await getWalletRecord();
      if (!walletRecord) throw new Error("No wallet record found");

      if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
        return { success: false, error: "Incorrect passcode" };
      }

      await saveSubAccountSeed(selectedAddress, seed, passcode);

      if (onSeedUpdated) {
        onSeedUpdated();
      }

      return { success: true };
    } catch (error) {
      console.error("Failed to save seed:", error);
      return { success: false, error: "Failed to save seed" };
    }
  };

  const columns = React.useMemo(
    () => [
      columnHelper.accessor("address", {
        header: "Address",
        cell: (cell) => {
          const value = cell.getValue();
          const disabled = isDisabled(value);

          return (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <CopyableCell
                  title="Copy Address"
                  toastMessage="Address Copied Successfully!"
                  copyAbleText={value}
                />
                {disabled && (
                  <CustomTooltip
                    tooltip={
                      <div className="max-w-[220px]">
                        This API key is being used to store and sync files to S3 from our backend.
                        It cannot be deleted to ensure secure synchronization of your files.
                      </div>
                    }
                    className="cursor-pointer mt-1"
                  >
                    <Lock className="size-4 ml-1" />
                  </CustomTooltip>
                )}
              </div>
            </div>
          );
        }
      }),

      columnHelper.accessor("role", {
        header: "Permission",
        cell: (info) => {
          const role = info.getValue();
          const displayRole = role === "UploadDelete" ? "Upload/Delete" : role;
          return (
            <span className="inline-block px-2 py-1 bg-grey-90 border border-grey-80 text-grey-40 rounded text-xs">
              {displayRole}
            </span>
          );
        }
      }),

      columnHelper.accessor("seed", {
        header: () => (
          <div className="w-full flex justify-center text-center">Seed</div>
        ),
        size: 40,
        maxSize: 40,
        cell: ({ row }) => {
          const address = row.original.address;
          const seedExists = hasSeed(address);
          const disabled = isDisabled(address);

          return (
            <div className="flex justify-center">
              {seedExists ? (
                <button
                  onClick={() => handleViewSeed(address)}
                  title="View Seed"
                  className={cn("text-grey-70 hover:text-primary-50 transition", { 'cursor-not-allowed opacity-50 pointer-events-none': disabled })}
                  disabled={disabled}
                >
                  <ShieldSecurity className="size-5 text-primary-40" />
                </button>
              ) : (
                <button
                  onClick={() => handleSetSeed(address)}
                  title="Set Seed"
                  className={cn("text-grey-70 hover:text-primary-50 transition", { 'cursor-not-allowed opacity-50 pointer-events-none': disabled })}
                  disabled={disabled}
                >
                  <Icons.AddCircle className="size-5" />
                </button>
              )}
            </div>
          );
        }
      }),

      columnHelper.display({
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const s = row.original;
          const disabled = isDisabled(s.address);
          return (
            <div className="flex justify-center items-center">
              <button
                onClick={() => onDelete(s.address)}
                title={disabled ? "Cannot delete disabled account" : "Delete"}
                disabled={disabled}
                className={cn("text-grey-70 hover:text-red-600 transition", { "cursor-not-allowed opacity-50": disabled })}
              >
                <Icons.Trash className="size-5" />
              </button>
            </div>
          );
        }
      })
    ],
    [hasSeed, isDisabled, onDelete]
  );

  const table = useReactTable({
    data: paginatedData,
    columns,
    getCoreRowModel: getCoreRowModel()
  });

  return (
    <>
      <TableWrapper className="mt-4 bg-white overflow-visible">
        {loading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="animate-spin text-gray-500 size-8" />
          </div>
        ) : table.getRowModel().rows.length === 0 ? (
          <div className="p-6 flex justify-center text-gray-500">
            {subs.length === 0
              ? "No API keys yet"
              : "No API keys on this page"}
          </div>
        ) : (
          <>
            <Table>
              <THead>
                {table.getHeaderGroups().map((hg) => (
                  <Tr key={hg.id}>
                    {hg.headers.map((header) => (
                      <Th
                        key={header.id}
                        header={header}
                        align={header.id === "seed" ? "center" : "left"}
                        onResizeStart={handleResizeStart}
                      />
                    ))}
                  </Tr>
                ))}
              </THead>
              <TBody>
                {table.getRowModel().rows.map((row) => {
                  return (
                    <Tr
                      key={row.id}
                      className="border-t border-grey-80"
                    >
                      {row.getVisibleCells().map((cell) => (
                        <Td key={cell.id} cell={cell} columnWidth={columnWidths[cell.column.id]} />
                      ))}
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </>
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

      <ViewSeedModal
        open={isViewSeedModalOpen}
        onClose={() => setIsViewSeedModalOpen(false)}
        address={selectedAddress}
      />

      {/* Set Seed Modal */}
      <SeedPasscodeModal
        open={isSetSeedModalOpen}
        onClose={() => setIsSetSeedModalOpen(false)}
        title="Set API Key Seed"
        description="Enter seed phrase for API key"
        address={selectedAddress}
        seedInputRequired={true}
        onSubmit={handleSetSeedSubmit}
        cancelLabel="Cancel"
        submitLabel="Set Seed"
      />
    </>
  );
};

export default APIKeysTable;
