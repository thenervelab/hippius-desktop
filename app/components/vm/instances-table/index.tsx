/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { FC, useMemo } from "react";
import React from "react";
import { P } from "../../ui/typography";
import { cn } from "@/lib/utils";
import { getDesktopColumns, buildInstanceMenuItems } from "./instances-columns";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import useVMInstances from "@/app/lib/hooks/api/useVMInstances";
import { VMFlavorResponse } from "@/app/lib/hooks/api/useVMFlavors";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { usePagination } from "@/app/lib/hooks";
import NoEntriesFound from "../../ui/NoEntriesFound";
import Skeleton from "../../ui/skeleton";
import InstanceRowContextMenu from "./InstanceRowContextMenu";

export interface Instance {
  id: number;
  uuid: string | null;
  name: string;
  status: string;
  flavor: string;
  image: string;
  public_ip: string | null;
  nebula_ip: string | null;
  created_at: string;
}

export interface VMTablePaginationState {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalCount: number;
  hasData: boolean;
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  setPage: (page: number) => void;
}

interface InstancesTableProps {
  onDeleteInstance?: (instance: Instance) => void;
  onCreateNew?: () => void;
  flavors?: VMFlavorResponse[];
  isFlavorsLoading?: boolean;
  searchTerm?: string;
  onError?: (error: Error | null) => void;
  onRefetchChange?: (refetch: () => void) => void;
  onFetchingChange?: (isFetching: boolean) => void;
  onPaginationChange?: (pagination: VMTablePaginationState) => void;
}

const InstancesTable: FC<InstancesTableProps> = ({
  onDeleteInstance,
  onCreateNew,
  flavors,
  isFlavorsLoading,
  searchTerm = "",
  onError,
  onRefetchChange,
  onFetchingChange,
  onPaginationChange,
}) => {
  const {
    data: instances,
    isLoading,
    error,
    isFetching,
    refetch,
  } = useVMInstances();
  // Pass error, refetch, and isFetching to parent
  React.useEffect(() => {
    onError?.(error || null);
  }, [error, onError]);

  React.useEffect(() => {
    if (onRefetchChange) {
      onRefetchChange(refetch);
    }
  }, [refetch, onRefetchChange]);

  React.useEffect(() => {
    onFetchingChange?.(isFetching);
  }, [isFetching, onFetchingChange]);

  // Filter instances locally based on search term (memoized for performance)
  const filteredInstances = useMemo(() => {
    if (!instances) return [];
    if (!searchTerm.trim()) return instances;

    const searchLower = searchTerm.toLowerCase().trim();
    return instances.filter((instance) =>
      instance.name.toLowerCase().includes(searchLower),
    );
  }, [instances, searchTerm]);

  // Use client-side pagination on filtered data
  const pageSize = 10;
  const {
    paginatedData: data,
    setCurrentPage,
    currentPage,
    totalPages,
  } = usePagination(filteredInstances, pageSize);
  const safeTotalPages = Math.max(1, totalPages);

  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, setCurrentPage]);

  React.useEffect(() => {
    if (currentPage > safeTotalPages) {
      setCurrentPage(safeTotalPages);
    }
  }, [currentPage, safeTotalPages, setCurrentPage]);

  React.useEffect(() => {
    onPaginationChange?.({
      currentPage,
      totalPages: safeTotalPages,
      pageSize,
      totalCount: filteredInstances.length,
      hasData: filteredInstances.length > 0,
      isLoading: isLoading || !!isFlavorsLoading,
      isRefetching: isFetching && !isLoading,
      isError: !!error,
      setPage: setCurrentPage,
    });
  }, [
    currentPage,
    safeTotalPages,
    filteredInstances.length,
    isLoading,
    isFlavorsLoading,
    isFetching,
    error,
    onPaginationChange,
    setCurrentPage,
  ]);

  // Instance control hooks
  const { handleStartStopInstance, StartStopConfirmModal } =
    useStartStopInstance();
  const { handleRebootInstance, RebootConfirmModal } = useRebootInstance();

  // Row right-click menu — mirrors the kebab dropdown but pops up at
  // the cursor. The kebab button has its own click handler and lives
  // inside `.action-menu-area`; we skip opening the context menu when
  // the user right-clicks inside it so the native kebab flow wins.
  const [rowContextMenu, setRowContextMenu] = React.useState<{
    instance: Instance;
    x: number;
    y: number;
  } | null>(null);

  const handleRowContextMenu = React.useCallback(
    (e: React.MouseEvent, instance: Instance) => {
      // Always suppress the browser's native context menu inside our
      // rows. If the user right-clicks on the kebab area we still
      // suppress, but don't open our own menu — that surface is
      // reserved for the existing left-click flow.
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest(".action-menu-area")) return;
      window.getSelection()?.removeAllRanges();
      setRowContextMenu({ instance, x: e.clientX, y: e.clientY });
    },
    [],
  );

  // Get columns with the handlers
  const desktopColumns = getDesktopColumns(
    flavors,
    onDeleteInstance,
    handleStartStopInstance,
    handleRebootInstance,
  );

  const table = useReactTable({
    columns: desktopColumns,
    data: data || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: false,
    columnResizeMode: "onChange",
  });

  // Figma-spec styling overrides. The base Th/Td set semibold/text-grey-70 and
  // beefy py-3 padding for the older app tables; here we pin explicit heights
  // (32px header, 26px row), add vertical column separators (border-r), and
  // recolor the header to match the design at nodes 4542:44307 / 4542:41801.
  // `leading-[16px]` on the header keeps the text content area exactly 16px
  // so 8px+16px+8px fits in 32px without the default 1.5 line-height blowing
  // it past target.
  const headerThClassName =
    "h-[32px] border-b border-r last:border-r-0 px-[10px] py-[8px] " +
    "text-[12px] leading-[16px] font-semibold tracking-[-0.24px] " +
    "text-[#a3a3a3] dark:text-[#a3a3a3] " +
    "bg-[#fefefe] dark:bg-black-600 " +
    "border-[#e3e3e3] dark:border-[#313131]";

  const bodyTdBaseClassName =
    "h-[26px] px-[8px] py-[3px] border-r last:border-r-0 border-b-0 bg-transparent " +
    "border-[#e3e3e3] dark:border-[#313131] " +
    "font-medium text-[12px] leading-[16px] tracking-[-0.24px] text-[#1d1d1d] dark:text-white";

  const rowBgFor = (index: number) =>
    index % 2 === 0
      ? "*:bg-[#fbfbfb] dark:*:bg-[#161616]"
      : "*:bg-[#f5f5f5] dark:*:bg-[#1e1e1e]";

  return (
    <div className="flex flex-col gap-y-8">
      {/* TableWrapper's default `border border-grey-80 rounded` would
          stack a second card border inside the page-level Figma
          container; strip both so the table sits flush with the inner
          white card. */}
      <TableModule.TableWrapper className="duration-300 delay-300 border-0 rounded-none">
        {error ? (
          <div className="w-full h-[50rem] flex items-center justify-center p-6">
            <P className="text-error-70 font-medium">
              Oops an error occurred...
            </P>
          </div>
        ) : isLoading || isFetching || isFlavorsLoading ? (
          <TableModule.Table className="table-auto">
            <TableModule.THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableModule.Tr key={headerGroup.id} className="border-b-0">
                  {headerGroup.headers.map((header) => (
                    <TableModule.Th
                      key={header.id}
                      header={header}
                      align={header.id === "selection" ? "center" : "left"}
                      className={headerThClassName}
                      disableUppercase
                      sortIcon="rotating"
                      activeSortClassName="text-grey-10 dark:text-grey-light-100"
                    />
                  ))}
                </TableModule.Tr>
              ))}
            </TableModule.THead>
            <TableModule.TBody>
              {/* Skeleton rows deliberately skip the zebra striping used by
                  loaded rows: the placeholder bars (`bg-grey-90`) have very
                  low contrast against the `#fbfbfb`/`#f5f5f5` zebra tones,
                  so the loading state would read as washed-out blue bars on
                  beige rows. A flat white/dark row keeps the skeleton
                  visually crisp while still showing the column borders and
                  first/last-row breathing room from the loaded design. */}
              {Array.from({ length: 10 }).map((_, rowIndex, arr) => {
                const isFirst = rowIndex === 0;
                const isLast = rowIndex === arr.length - 1;
                const edgeRowHeight =
                  isFirst || isLast ? "h-[32px]" : "h-[26px]";
                const edgePadding = isFirst || isLast ? "py-[6px]" : "py-[3px]";
                return (
                  <tr
                    key={`skeleton-row-${rowIndex}`}
                    className={cn(
                      "animate-fade-in-0.3 border-0",
                      edgeRowHeight,
                      "*:bg-white dark:*:bg-[#161616]",
                    )}
                  >
                    {[
                      "100px",
                      "160px",
                      "140px",
                      "100px",
                      "100px",
                      "90px",
                      "actions",
                    ].map((width, colIndex, cols) => {
                      const isActions = colIndex === cols.length - 1;
                      return (
                        <td
                          key={`skeleton-cell-${rowIndex}-${colIndex}`}
                          className={cn(
                            "px-[8px] align-middle border-r last:border-r-0 border-[#e3e3e3] dark:border-[#313131]",
                            edgeRowHeight,
                            edgePadding,
                            isActions && "w-[35px] min-w-[35px] max-w-[35px] px-0",
                          )}
                        >
                          {isActions ? (
                            <div className="flex justify-center">
                              <Skeleton
                                variant="circle"
                                height="1.25rem"
                                width="1.25rem"
                              />
                            </div>
                          ) : (
                            <Skeleton height="0.75rem" width={width} />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </TableModule.TBody>
          </TableModule.Table>
        ) : !data.length ? (
          searchTerm && searchTerm.trim() ? (
            <NoEntriesFound
              title="No matching instances found"
              description="Try clearing your search to see more results."
              cardView={false}
              className="!bg-white dark:!bg-black-600"
            />
          ) : (
            <NoEntriesFound
              title="No VM Instances Found"
              description="You currently do not have any virtual machine instances. Create your first VM to get started with cloud computing."
              buttonText={onCreateNew ? "Create VM" : undefined}
              onButtonClick={onCreateNew}
              cardView={false}
              className="!bg-white dark:!bg-black-600"
            />
          )
        ) : (
          <TableModule.Table className="table-auto">
            <TableModule.THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableModule.Tr key={headerGroup.id} className="border-b-0">
                  {headerGroup.headers.map((header) => (
                    <TableModule.Th
                      key={header.id}
                      header={header}
                      className={headerThClassName}
                      disableUppercase
                      sortIcon="rotating"
                      activeSortClassName="text-grey-10 dark:text-grey-light-100"
                    />
                  ))}
                </TableModule.Tr>
              ))}
            </TableModule.THead>

            <TableModule.TBody>
              {table.getRowModel().rows?.map((row, index) => {
                const isFirst = index === 0;
                const isLast = index === table.getRowModel().rows.length - 1;
                // First/last rows grow from 26px → 32px so the 6px breathing
                // room sits INSIDE the row band — the column borders extend
                // straight through it. `h-[32px] py-[6px]` keeps the
                // pill/icon content vertically centered with only a tiny
                // (~3px) offset from middle rows.
                const edgeClass = isFirst || isLast ? "h-[32px] py-[6px]" : "";
                return (
                  <TableModule.Tr
                    key={`${row.id}`}
                    className={cn(
                      "border-b-0",
                      isFirst || isLast ? "h-[32px]" : "h-[26px]",
                      rowBgFor(index),
                    )}
                    onContextMenu={(e) =>
                      handleRowContextMenu(e, row.original)
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableModule.Td
                        className={cn(
                          bodyTdBaseClassName,
                          edgeClass,
                          cell.column.id === "actions" && "w-8",
                          (cell.column.columnDef.meta as any)?.cellClassName,
                        )}
                        key={cell.id}
                        cell={cell}
                      />
                    ))}
                  </TableModule.Tr>
                );
              })}
            </TableModule.TBody>
          </TableModule.Table>
        )}
      </TableModule.TableWrapper>

      {safeTotalPages > 1 && (
        <TableModule.Pagination
          currentPage={currentPage}
          totalPages={safeTotalPages}
          setPage={setCurrentPage}
        />
      )}

      {/* Instance Control Modals */}
      <StartStopConfirmModal />
      <RebootConfirmModal />

      {rowContextMenu && (
        <InstanceRowContextMenu
          x={rowContextMenu.x}
          y={rowContextMenu.y}
          items={buildInstanceMenuItems(rowContextMenu.instance, {
            onDelete: onDeleteInstance,
            onStartStop: handleStartStopInstance,
            onReboot: handleRebootInstance,
          })}
          onClose={() => setRowContextMenu(null)}
        />
      )}
    </div>
  );
};

export default InstancesTable;
