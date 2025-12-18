import {
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { FC, useMemo, useState, useEffect } from "react";
import { Key } from "lucide-react";
import { P } from "../../ui/typography";
import { cn } from "@/lib/utils";
import { getDesktopColumns } from "./ssh-keys-columns";
import useSSHKeys from "@/app/lib/hooks/api/useSSHKeys";
import NoDataFound from "../../ui/NoDataFound";

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
}

const SSHKeysTable: FC<SSHKeysTableProps> = ({
  onDeleteKey,
  searchTerm = "",
  refreshTrigger,
  onRefetchingChange,
  onCreateNew,
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

  // Get columns with the deletion handler
  const desktopColumns = getDesktopColumns(onDeleteKey);

  const table = useReactTable({
    columns: desktopColumns,
    data: data || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="flex flex-col gap-y-8">
      <TableModule.TableWrapper className=" duration-300 delay-300">
        {error ? (
          <div className="w-full h-[800px] flex items-center justify-center p-6">
            <P className="text-error-70 font-medium">
              Oops an error occured...
            </P>
          </div>
        ) : isLoading || isRefetching ? (
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
                rowClassName="h-[69px]"
                rows={10}
                columns={6}
                columnWidths={[
                  "150px",
                  "250px",
                  "150px",
                  "150px",
                  "150px",
                  "70px",
                ]}
              />
            </TableModule.TBody>
          </TableModule.Table>
        ) : !data || data.length === 0 ? (
          <NoDataFound
            icon={Key}
            title="No SSH Keys Found"
            description="You currently do not have any SSH keys. Create your first SSH key to securely access your virtual machines."
            buttonText="New SSH Key"
            onButtonClick={onCreateNew || (() => {})}
            showButton={!!onCreateNew}
          />
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
                        className={cn(cell.column.id === "actions" && "w-8")}
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

      {totalPages > 1 && (
        <TableModule.Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          setPage={setCurrentPage}
        />
      )}
    </div>
  );
};

export default SSHKeysTable;
