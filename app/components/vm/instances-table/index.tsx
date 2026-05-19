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
import { getDesktopColumns } from "./instances-columns";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import useVMInstances from "@/app/lib/hooks/api/useVMInstances";
import { VMFlavorResponse } from "@/app/lib/hooks/api/useVMFlavors";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { usePagination } from "@/app/lib/hooks";
import NoDataFound from "../../ui/NoDataFound";
import { Server } from "lucide-react";

export interface Instance {
  id: number;
  uuid: string | null;
  name: string;
  status: string;
  flavor: string;
  image: string;
  public_ip: string | null;
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
      instance.name.toLowerCase().includes(searchLower)
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

  // Get columns with the handlers
  const desktopColumns = getDesktopColumns(
    flavors,
    onDeleteInstance,
    handleStartStopInstance,
    handleRebootInstance
  );

  const table = useReactTable({
    columns: desktopColumns,
    data: data || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: false,
    columnResizeMode: "onChange",
  });

  return (
    <div className="flex flex-col gap-y-8">
      <TableModule.TableWrapper className=" duration-300 delay-300">
        {error ? (
          <div className="w-full h-[50rem] flex items-center justify-center p-6">
            <P className="text-error-70 font-medium">
              Oops an error occurred...
            </P>
          </div>
        ) : isLoading || isFetching || isFlavorsLoading ? (
          <TableModule.Table>
            <TableModule.THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableModule.Tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableModule.Th
                      key={header.id}
                      header={header}
                      align={header.id === "selection" ? "center" : "left"}
                    />
                  ))}
                </TableModule.Tr>
              ))}
            </TableModule.THead>
            <TableModule.TBody>
              <TableModule.SkeletonTableRow
                rowClassName="h-[4.3125rem]"
                rows={10}
                columns={7}
                columnWidths={[
                  "6.25rem",
                  "10rem",
                  "8.75rem",
                  "6.25rem",
                  "6.25rem",
                  "5.625rem",
                  "3.125rem",
                ]}
              />
            </TableModule.TBody>
          </TableModule.Table>
        ) : !data.length ? (
          searchTerm && searchTerm.trim() ? (
            <NoDataFound
              icon={Server}
              title="No matching instances found"
              description=""
              showButton={false}
            />
          ) : (
            <NoDataFound
              icon={Server}
              title="No VM Instances Found"
              description="You currently do not have any virtual machine instances. Create your first VM to get started with cloud computing."
              buttonText="Create VM"
              onButtonClick={onCreateNew || (() => {})}
              showButton={!!onCreateNew}
            />
          )
        ) : (
          <TableModule.Table>
            <TableModule.THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableModule.Tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableModule.Th key={header.id} header={header} />
                  ))}
                </TableModule.Tr>
              ))}
            </TableModule.THead>

            <TableModule.TBody>
              {table.getRowModel().rows?.map((row) => {
                return (
                  <TableModule.Tr rowHover key={`${row.id}`} transparent>
                    {row.getVisibleCells().map((cell) => (
                      <TableModule.Td
                        className={cn(
                          cell.column.id === "actions" && "w-8",
                          (cell.column.columnDef.meta as any)?.cellClassName
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
    </div>
  );
};

export default InstancesTable;
