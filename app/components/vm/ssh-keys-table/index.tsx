import {
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { FC } from "react";
import { P } from "../../ui/typography";
import { cn } from "@/lib/utils";
import { getDesktopColumns } from "./ssh-keys-columns";
import { MOCK_SSH_KEYS } from "./mock-data";
import { usePagination } from "@/app/lib/hooks";
import NoEntriesFound from "../../ui/alt-table/NoEntriesFound";

export interface SSHKey {
  id: string;
  keyName: string;
  sshKey: string;
  dateCreated: string;
}

interface SSHKeysTableProps {
  onDeleteKey?: (sshKey: SSHKey) => void;
}

const SSHKeysTable: FC<SSHKeysTableProps> = ({ onDeleteKey }) => {
  const queryData = MOCK_SSH_KEYS;
  const isLoading = false;
  const isRefetching = false;
  const error = "";

  const {
    paginatedData: data,
    setCurrentPage,
    currentPage,
    totalPages,
  } = usePagination(queryData || [], 10);

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
        ) : isLoading || isRefetching || !data ? (
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
                columns={4}
                columnWidths={["180px", "400px", "180px", "70px"]}
              />
            </TableModule.TBody>
          </TableModule.Table>
        ) : !data.length ? (
          <NoEntriesFound />
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
