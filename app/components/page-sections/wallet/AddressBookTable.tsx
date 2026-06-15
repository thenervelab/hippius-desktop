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
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import { Edit, Loader2, MoreVertical, Plus, Trash, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { deleteContact } from "@/app/lib/helpers/addressBookDb";
import ConfirmationDialog from "@/app/components/ConfirmationDialog";
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
  /** Opens the Add Address dialog. Used by the empty-state CTA so the
      user can start populating the address book without scrolling back
      up to the page-level "New Address" header chip. */
  onAddAddress?: () => void;
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
  onAddAddress,
  isLoading,
}) => {
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [contactToDelete, setContactToDelete] = useState<Contact | null>(null);
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

  const requestDelete = useCallback((contact: Contact) => {
    setContactToDelete(contact);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!contactToDelete) return;
    try {
      setIsDeleting(true);
      const success = await deleteContact(contactToDelete.id);
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
      setContactToDelete(null);
    }
  }, [contactToDelete, onContactChanged]);

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
            textColor="text-grey-20 dark:text-grey-dark-200"
            // No `isTable` / `numberOfCharactersFromStartAndEnd` here:
            // FROM/TO in the transaction history share a row 50/50
            // and need fixed truncation, but the address book has one
            // address column with plenty of room. With both props
            // omitted, CopyableCell falls through to its breakpoint
            // path — which returns the full SS58 address on
            // laptop/desktop/large-desktop (≥ 1024px) so the user
            // can see the whole value.
          />
        ),
      }),
      col.accessor("dateAdded", {
        header: "DATE ADDED",
        enableSorting: true,
        meta: {
          headerClassName: "w-[20%]",
          cellClassName: "w-[20%]",
        },
        cell: (info) => (
          <span className="font-medium whitespace-nowrap text-grey-dark-800 dark:text-grey-dark-500">
            {formatDate(new Date(info.getValue()), "long")}
          </span>
        ),
      }),
      col.display({
        id: "actions",
        header: "",
        meta: {
          headerClassName: "w-[36px] px-0",
          cellClassName: "w-[36px] px-0",
        },
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
              onItemClick: () => requestDelete(contact),
              variant: "destructive" as const,
            },
          ];
          return (
            <div className="flex w-full items-center justify-center">
              <TableActionMenu dropdownTitle="Address Options" items={items}>
                <Button
                  variant="ghost"
                  size="auto"
                  className="h-8 w-8 p-0 text-grey-70 dark:text-grey-dark-500"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </TableActionMenu>
            </div>
          );
        },
      }),
    ],
    [handleEdit, requestDelete],
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

  // Empty state — mirrors Files page via NoEntriesFound. CTA wires
  // through to the parent's AddNewAddressDialog so the user can act
  // without scrolling back up to the page header.
  if (totalCount === 0) {
    return (
      <div className="p-3">
        <NoEntriesFound
          title="No saved addresses yet"
          description="Save the addresses you send to most often so you don't have to paste an SS58 every time."
          buttonText={onAddAddress ? "Add Address" : undefined}
          buttonIcon={<Plus className="size-4" />}
          onButtonClick={onAddAddress}
          cardView={false}
          className="p-6 sm:p-10 rounded-[8px]"
        />
      </div>
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

      <ConfirmationDialog
        open={!!contactToDelete}
        onClose={() => !isDeleting && setContactToDelete(null)}
        onConfirm={confirmDelete}
        onBack={() => setContactToDelete(null)}
        heading="Delete Address"
        text={
          contactToDelete
            ? `Are you sure you want to delete "${contactToDelete.name}" from your address book? This action cannot be undone.`
            : ""
        }
        button={isDeleting ? "Deleting..." : "Delete Address"}
        icon={<Trash2 className="size-[18px] text-white" strokeWidth={2.5} />}
        iconBgColor="bg-[#fc7d73]"
        confirmVariant="destructive"
        disableButton={isDeleting}
        disableBackButton={isDeleting}
      />
    </>
  );
};

export default AddressBookTable;
