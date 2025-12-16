import {
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { FC } from "react";
import { P } from "../../ui/typography";
import { cn } from "@/lib/utils";
import { getDesktopColumns } from "./instances-columns";
import { MOCK_INSTANCES } from "./mock-data";
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { useReinstallInstance } from "../hooks/useReinstallInstance";
import { usePagination } from "@/app/lib/hooks";
import NoEntriesFound from "../../ui/alt-table/NoEntriesFound";

export interface Instance {
  id: string;
  name: string;
  minerId: string;
  template: {
    model?: string;
    cpu: string;
    ram: string;
    gpu: string;
    processor?: string;
    storage?: string;
    bandwidth?: string;
    price?: string;
  };
  image: {
    os: "Linux" | "Ubuntu";
    version: string;
  };
  ipAddress: string;
  network?: {
    ipv4: string;
    ipv4Gateway: string;
    ipv6: string;
    ipv6Gateway: string;
    sshLogin: string;
    sshKey: string;
  };
  status:
    | "Running"
    | "Connected"
    | "Stopped"
    | "Starting"
    | "Pending"
    | "Stopping"
    | "Failed";
}

interface InstancesTableProps {
  onDeleteInstance?: (instance: Instance) => void;
}

const InstancesTable: FC<InstancesTableProps> = ({ onDeleteInstance }) => {
  const queryData = MOCK_INSTANCES;
  const isLoading = false;
  const isRefetching = false;
  const error = "";

  const {
    paginatedData: data,
    setCurrentPage,
    currentPage,
    totalPages,
  } = usePagination(queryData || [], 12);

  // Instance control hooks
  const { handleStartStopInstance, StartStopConfirmModal } =
    useStartStopInstance();
  const { handleRebootInstance, RebootConfirmModal } = useRebootInstance();
  const { handleReinstallInstance, ReinstallConfirmModal } =
    useReinstallInstance();

  // Get columns with the handlers
  const desktopColumns = getDesktopColumns(
    onDeleteInstance,
    handleStartStopInstance,
    handleRebootInstance,
    handleReinstallInstance
  );

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
                columns={6}
                columnWidths={[
                  "180px",
                  "220px",
                  "200px",
                  "140px",
                  "140px",
                  "70px",
                ]}
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

      {/* Instance Control Modals */}
      <StartStopConfirmModal />
      <RebootConfirmModal />
      <ReinstallConfirmModal />
    </div>
  );
};

export default InstancesTable;
