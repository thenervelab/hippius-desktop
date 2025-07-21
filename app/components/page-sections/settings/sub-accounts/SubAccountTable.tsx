"use client";

import React, { useState, useMemo } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
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
  Pagination,
} from "@/components/ui/alt-table";
import { Loader2 } from "lucide-react";
import { SubAccount } from "@/app/lib/hooks/api/useSubAccounts";
import { Icons } from "@/app/components/ui";

type Props = {
  subs: SubAccount[];
  loading: boolean;
  onDelete: (addr: string) => void;
};

const columnHelper = createColumnHelper<SubAccount>();
const ITEMS_PER_PAGE = 10;

const SubAccountTable: React.FC<Props> = ({ subs, loading, onDelete }) => {
  const [currentPage, setCurrentPage] = useState(1);

  // Calculate pagination
  const totalPages = useMemo(
    () => Math.ceil(subs.length / ITEMS_PER_PAGE),
    [subs.length]
  );

  // Get paginated data
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return subs.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [subs, currentPage]);

  const columns = React.useMemo(
    () => [
      // Address with copy button
      columnHelper.accessor("address", {
        header: "Address",
        cell: (cell) => {
          const value = cell.getValue();
          return (
            <CopyableCell
              title="Copy Address"
              toastMessage="Address Copied Successfully!"
              copyAbleText={value}
            />
          );
        },
      }),

      // Role as pill
      columnHelper.accessor("role", {
        header: "Role",
        cell: (info) => (
          <span className="inline-block px-2 py-1 bg-grey-90 border border-grey-80 text-grey-40 rounded text-xs">
            {info.getValue()}
          </span>
        ),
      }),

      // Actions: only delete
      columnHelper.display({
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <div className="flex justify-center items-center">
              <button
                onClick={() => onDelete(s.address)}
                title="Delete"
                className="text-grey-70 hover:text-red-600 transition"
              >
                <Icons.Trash className="size-5" />
              </button>
            </div>
          );
        },
      }),
    ],
    [onDelete]
  );

  const table = useReactTable({
    data: paginatedData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <TableWrapper className="mt-4">
      {loading ? (
        <div className="p-8 flex justify-center">
          <Loader2 className="animate-spin text-gray-500 size-8" />
        </div>
      ) : table.getRowModel().rows.length === 0 ? (
        <div className="p-6 flex justify-center text-gray-500">
          {subs.length === 0
            ? "No sub accounts yet"
            : "No sub accounts on this page"}
        </div>
      ) : (
        <>
          <Table>
            <THead>
              {table.getHeaderGroups().map((hg) => (
                <Tr key={hg.id}>
                  {hg.headers.map((header) => (
                    <Th key={header.id} header={header} />
                  ))}
                </Tr>
              ))}
            </THead>
            <TBody>
              {table.getRowModel().rows.map((row) => (
                <Tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <Td key={cell.id} cell={cell} />
                  ))}
                </Tr>
              ))}
            </TBody>
          </Table>

          {/* Only show pagination if there's more than one page */}
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
      )}
    </TableWrapper>
  );
};

export default SubAccountTable;
