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
import { useStartStopInstance } from "../hooks/useStartStopInstance";
import useVMInstances from "@/app/lib/hooks/api/useVMInstances";
import { VMFlavorResponse } from "@/app/lib/hooks/api/useVMFlavors";
import { useRebootInstance } from "../hooks/useRebootInstance";
import { useReinstallInstance } from "../hooks/useReinstallInstance";
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
  nebula_ip: string | null;
  created_at: string;
}

interface InstancesTableProps {
  onDeleteInstance?: (instance: Instance) => void;
  onCreateNew?: () => void;
  flavors?: VMFlavorResponse[];
  isFlavorsLoading?: boolean;
}

const InstancesTable: FC<InstancesTableProps> = ({
  onDeleteInstance,
  onCreateNew,
  flavors,
  isFlavorsLoading,
}) => {
  const { data: instances, isLoading, error, isRefetching } = useVMInstances();

  // Use client-side pagination
  const {
    paginatedData: data,
    setCurrentPage,
    currentPage,
    totalPages,
  } = usePagination(instances || [], 10);

  // Instance control hooks
  const { handleStartStopInstance, StartStopConfirmModal } =
    useStartStopInstance();
  const { handleRebootInstance, RebootConfirmModal } = useRebootInstance();
  const { handleReinstallInstance, ReinstallConfirmModal } =
    useReinstallInstance();

  // Get columns with the handlers
  const desktopColumns = getDesktopColumns(
    flavors,
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
              Oops an error occurred...
            </P>
          </div>
        ) : isLoading || isRefetching || isFlavorsLoading ? (
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
                columns={8}
                columnWidths={[
                  "100px",
                  "160px",
                  "140px",
                  "100px",
                  "100px",
                  "90px",
                  "100px",
                  "50px",
                ]}
              />
            </TableModule.TBody>
          </TableModule.Table>
        ) : !data.length ? (
          <NoDataFound
            icon={Server}
            title="No VM Instances Found"
            description="You currently do not have any virtual machine instances. Create your first VM to get started with cloud computing."
            buttonText="Create VM"
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

      {/* Instance Control Modals */}
      <StartStopConfirmModal />
      <RebootConfirmModal />
      <ReinstallConfirmModal />
    </div>
  );
};

export default InstancesTable;
