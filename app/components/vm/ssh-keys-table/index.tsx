/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { FC, useCallback, useMemo, useState, useEffect } from "react";
import { P } from "../../ui/typography";
import { cn } from "@/lib/utils";
import { getDesktopColumns, buildSSHKeyMenuItems } from "./ssh-keys-columns";
import useSSHKeys from "@/app/lib/hooks/api/useSSHKeys";
import NoEntriesFound from "../../ui/NoEntriesFound";
import Skeleton from "../../ui/skeleton";
import type { VMTablePaginationState } from "../instances-table";
import InstanceRowContextMenu from "../instances-table/InstanceRowContextMenu";

export interface SSHKey {
  id: number;
  name: string;
  public_key: string;
  fingerprint: string;
  created: string;
  last_used: string;
}

interface SSHKeysTableProps {
  onDeleteKey?: (sshKey: SSHKey) => void;
  searchTerm?: string;
  refreshTrigger?: number;
  onRefetchingChange?: (isRefetching: boolean) => void;
  onCreateNew?: () => void;
  onPaginationChange?: (pagination: VMTablePaginationState) => void;
}

const SSHKeysTable: FC<SSHKeysTableProps> = ({
  onDeleteKey,
  searchTerm = "",
  refreshTrigger,
  onRefetchingChange,
  onCreateNew,
  onPaginationChange,
}) => {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(10);

  const {
    data: apiData,
    isLoading,
    error,
    isRefetching,
    refetch,
  } = useSSHKeys({
    page: currentPage,
    page_size: pageSize,
    search: searchTerm,
  });

  const data = apiData?.results || [];

  // Calculate total pages based on API response
  const totalPages = useMemo(() => {
    if (!apiData?.count) return 1;
    return Math.ceil(apiData.count / pageSize);
  }, [apiData?.count, pageSize]);

  // Reset to first page when search term changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  // Trigger refetch when refreshTrigger changes
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      refetch();
    }
  }, [refreshTrigger, refetch]);

  // Notify parent of refetching state changes
  useEffect(() => {
    if (onRefetchingChange) {
      onRefetchingChange(isRefetching);
    }
  }, [isRefetching, onRefetchingChange]);

  const totalCount = apiData?.count ?? 0;
  const safeTotalPages = Math.max(1, totalPages);

  useEffect(() => {
    onPaginationChange?.({
      currentPage,
      totalPages: safeTotalPages,
      pageSize,
      totalCount,
      hasData: data.length > 0,
      isLoading,
      isRefetching,
      isError: !!error,
      setPage: setCurrentPage,
    });
  }, [
    currentPage,
    safeTotalPages,
    pageSize,
    totalCount,
    data.length,
    isLoading,
    isRefetching,
    error,
    onPaginationChange,
  ]);

  // Row right-click menu — mirrors the kebab dropdown but pops up at
  // the cursor. The kebab button lives inside `.action-menu-area`; we
  // skip opening the context menu when the user right-clicks inside it
  // so the native kebab flow wins.
  const [rowContextMenu, setRowContextMenu] = useState<{
    sshKey: SSHKey;
    x: number;
    y: number;
  } | null>(null);

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent, sshKey: SSHKey) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.closest(".action-menu-area")) return;
      window.getSelection()?.removeAllRanges();
      setRowContextMenu({ sshKey, x: e.clientX, y: e.clientY });
    },
    [],
  );

  // Get columns with the deletion handler
  const desktopColumns = getDesktopColumns(onDeleteKey);

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
        ) : isLoading || isRefetching ? (
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
                      "120px",
                      "200px",
                      "160px",
                      "100px",
                      "100px",
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
        ) : !data || data.length === 0 ? (
          searchTerm && searchTerm.trim() ? (
            <NoEntriesFound
              title="No matching SSH keys found"
              description="Try clearing your search to see more results."
              cardView={false}
              className="!bg-white dark:!bg-black-600"
            />
          ) : (
            <NoEntriesFound
              title="No SSH Keys Found"
              description="You currently do not have any SSH keys. Create your first SSH key to securely access your virtual machines."
              buttonText={onCreateNew ? "New SSH Key" : undefined}
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

      {rowContextMenu && (
        <InstanceRowContextMenu
          x={rowContextMenu.x}
          y={rowContextMenu.y}
          items={buildSSHKeyMenuItems(rowContextMenu.sshKey, {
            onDelete: onDeleteKey,
          })}
          onClose={() => setRowContextMenu(null)}
        />
      )}
    </div>
  );
};

export default SSHKeysTable;
