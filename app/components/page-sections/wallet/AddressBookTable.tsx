"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Table,
  TableWrapper,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  Pagination,
  MiniPaginationControl,
  SkeletonTableRow,
} from "@/components/ui/table";
import { CopyableCell } from "@/components/ui/alt-table";
import TableActionMenu from "@/app/components/ui/alt-table/TableActionMenu";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/ui";
import { Edit, Loader2, MoreVertical, Trash } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { deleteContact } from "@/app/lib/helpers/addressBookDb";
import EditAddressDialog from "./EditAddressDialog";
import { formatDate } from "./TransactionHistoryTable";

interface Contact {
  id: number;
  name: string;
  walletAddress: string;
  dateAdded: number;
}

interface AddressBookTableProps {
  contacts: Contact[];
  onContactChanged: () => void;
  /** When true the loading skeleton renders even if `contacts` is
   * empty (e.g. while the initial IndexedDB read resolves). */
  isLoading?: boolean;
}

const HEADERS = ["NAME", "WALLET ADDRESS", "DATE ADDED", ""];
const SKEL_WIDTHS = ["120px", "200px", "180px", "40px"];
const MIN_W = "min-w-[560px] sm:min-w-[780px]";
const DEFAULT_PAGE_SIZE = 10;

const col = createColumnHelper<Contact>();

const AddressBookTable: React.FC<AddressBookTableProps> = ({
  contacts,
  onContactChanged,
  isLoading,
}) => {
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const totalCount = contacts?.length ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  const pageData = useMemo(() => {
    if (!contacts || contacts.length === 0) return [];
    return contacts.slice((page - 1) * pageSize, page * pageSize);
  }, [contacts, page, pageSize]);

  const handleEdit = useCallback((contact: Contact) => {
    setSelectedContact(contact);
    setShowEditDialog(true);
  }, []);

  const handleDelete = useCallback(
    async (contact: Contact) => {
      try {
        setIsDeleting(true);
        const success = await deleteContact(contact.id);
        if (success) {
          toast.success("Address deleted successfully");
          onContactChanged();
        } else {
          toast.error("Failed to delete address");
        }
      } catch (error) {
        toast.error("An error occurred while deleting the address");
        console.error("Error deleting address:", error);
      } finally {
        setIsDeleting(false);
      }
    },
    [onContactChanged],
  );

  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: "NAME",
        enableSorting: true,
        cell: (info) => (
          <span className="font-medium text-grey-20 dark:text-grey-dark-200">
            {info.getValue()}
          </span>
        ),
      }),
      col.accessor("walletAddress", {
        header: "WALLET ADDRESS",
        cell: (info) => (
          <CopyableCell
            copyAbleText={info.getValue()}
            title="Copy Address"
            toastMessage="Address Copied Successfully!"
            isTable
          />
        ),
      }),
      col.accessor("dateAdded", {
        header: "DATE ADDED",
        enableSorting: true,
        cell: (info) => (
          <span className="font-medium text-grey-dark-800 dark:text-grey-dark-800">
            {formatDate(new Date(info.getValue()), "long")}
          </span>
        ),
      }),
      col.display({
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const contact = row.original;
          const items = [
            {
              icon: <Edit className="size-4" />,
              itemTitle: "Edit",
              onItemClick: () => handleEdit(contact),
            },
            {
              icon: <Trash className="size-4" />,
              itemTitle: "Delete",
              onItemClick: () => handleDelete(contact),
              variant: "destructive" as const,
            },
          ];
          return (
            <div className="flex w-full items-center justify-center">
              <TableActionMenu dropdownTitle="Address Options" items={items}>
                <Button
                  variant="ghost"
                  size="auto"
                  className="h-8 w-8 p-0 text-grey-70"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </TableActionMenu>
            </div>
          );
        },
      }),
    ],
    [handleEdit, handleDelete],
  );

  const table = useReactTable({
    columns,
    data: pageData,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  // Loading skeleton
  if (isLoading && totalCount === 0) {
    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className={MIN_W}>
            <THead>
              <Tr>
                {HEADERS.map((h, i) => (
                  <th
                    key={i}
                    className="h-[var(--table-row-height,36px)] border-b border-r border-[#E3E3E3] bg-white px-[var(--table-cell-padding-x,10px)] py-0 text-left text-[length:var(--table-header-font-size,10px)] font-semibold uppercase text-grey-dark-600 last:border-r-0 dark:border-[#313131] dark:!bg-[#111111] dark:text-grey-dark-700"
                  >
                    {h}
                  </th>
                ))}
              </Tr>
            </THead>
            <TBody>
              <SkeletonTableRow
                rows={DEFAULT_PAGE_SIZE}
                columns={HEADERS.length}
                columnWidths={SKEL_WIDTHS}
                rowClassName="odd:bg-[#fbfbfb] even:bg-[#f5f5f5] dark:odd:bg-[#161616] dark:even:bg-[#1e1e1e]"
                cellClassName="!border-[#E3E3E3] dark:!border-[#313131]"
              />
            </TBody>
          </Table>
        </div>
      </TableWrapper>
    );
  }

  // Empty state
  if (totalCount === 0) {
    return (
      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none">
        <div className="flex h-[21.875rem] w-full items-center justify-center p-6">
          <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
            <div className="size-10 rounded-full bg-primary-90 flex items-center justify-center mb-2">
              <Icons.DocumentText className="size-6 text-primary-50" />
            </div>
            <span className="text-grey-60 dark:text-grey-dark-600 text-sm font-medium max-w-[16.25rem] text-center">
              No saved addresses. Add a new address to get started.
            </span>
          </div>
        </div>
      </TableWrapper>
    );
  }

  return (
    <>
      {totalCount > DEFAULT_PAGE_SIZE && (
        <div className="flex justify-end px-3 pt-3 mb-3">
          <MiniPaginationControl
            currentPage={page}
            totalPages={totalPages}
            pageSize={pageSize}
            totalCount={totalCount}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          />
        </div>
      )}

      <TableWrapper className="border-0 shadow-none bg-transparent dark:bg-transparent dark:border-0 dark:shadow-none rounded-none relative">
        <div className="overflow-x-auto custom-scrollbar-thin">
          <Table className={MIN_W}>
            <THead>
              {table.getHeaderGroups().map((hg) => (
                <Tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <Th
                      key={h.id}
                      header={h}
                      className="bg-white dark:!bg-[#111111] !border-[#E3E3E3] dark:!border-[#313131]"
                    />
                  ))}
                </Tr>
              ))}
            </THead>
            <TBody>
              {table.getRowModel().rows.map((row) => (
                <Tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <Td
                      key={cell.id}
                      cell={cell}
                      className={cn(
                        "!border-[#E3E3E3] dark:!border-[#313131]",
                        row.index % 2 === 0
                          ? "bg-[#fbfbfb] dark:bg-[#161616]"
                          : "bg-[#f5f5f5] dark:bg-[#1e1e1e]",
                      )}
                    />
                  ))}
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>

        {isDeleting && (
          <div className="absolute inset-0 bg-white/50 dark:bg-black/50 flex items-center justify-center">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}
      </TableWrapper>

      {totalCount > DEFAULT_PAGE_SIZE && (
        <div className="px-3 pb-3 mt-3">
          <Pagination
            currentPage={page}
            totalPages={totalPages}
            setPage={setPage}
            totalCount={totalCount}
            pageSize={pageSize}
            setPageSize={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}

      {selectedContact && (
        <EditAddressDialog
          open={showEditDialog}
          onClose={() => setShowEditDialog(false)}
          contact={selectedContact}
          onEditSuccess={() => {
            onContactChanged();
            setShowEditDialog(false);
          }}
        />
      )}
    </>
  );
};

export default AddressBookTable;
