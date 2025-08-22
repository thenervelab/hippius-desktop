import React, { useState, useCallback, useMemo } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel
} from "@tanstack/react-table";
import {
  TableWrapper,
  Table,
  Tr,
  Td,
  Th,
  THead,
  TBody,
  CopyableCell,
  Pagination
} from "@/components/ui/alt-table";
import { Button } from "@/components/ui/button";
import { Edit, MoreVertical, Trash } from "lucide-react";
import { Loader2 } from "lucide-react";
import { Icons } from "@/app/components/ui";
import TableActionMenu from "@/app/components/ui/alt-table/TableActionMenu";
import { toast } from "sonner";
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
}

const columnHelper = createColumnHelper<Contact>();
const ITEMS_PER_PAGE = 10;

const AddressBookTable: React.FC<AddressBookTableProps> = ({
  contacts,
  onContactChanged
}) => {
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = useMemo(
    () => Math.ceil((contacts?.length || 0) / ITEMS_PER_PAGE),
    [contacts?.length]
  );

  const paginatedData = useMemo(() => {
    if (!contacts || contacts.length === 0) return [];
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return contacts.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [contacts, currentPage]);

  const handleEdit = (contact: Contact) => {
    setSelectedContact(contact);
    setShowEditDialog(true);
  };

  const handleDelete = async (contact: Contact) => {
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
  };

  const createTableItems = useCallback(
    (contact: Contact) => {
      return [
        {
          icon: <Edit className="size-4" />,
          itemTitle: "Edit",
          onItemClick: () => handleEdit(contact)
        },
        {
          icon: <Trash className="size-4" />,
          itemTitle: "Delete",
          onItemClick: () => handleDelete(contact),
          variant: "destructive" as const
        }
      ];
    },
    []
  );

  const columns = [
    columnHelper.accessor("name", {
      header: "NAME",
      enableSorting: true
    }),
    columnHelper.accessor("walletAddress", {
      header: "WALLET ADDRESS",
      enableSorting: false,
      cell: (info) => (
        <CopyableCell
          copyAbleText={info.getValue()}
          title="Copy Address"
          toastMessage="Address Copied Successfully!"
          isTable={true}
        />
      )
    }),
    columnHelper.accessor("dateAdded", {
      header: "DATE ADDED",
      enableSorting: true,

      cell: (info) => {
        return (
          <div className="text-grey-60">
            {formatDate(new Date(info.getValue()), "long")}
          </div>
        );
      }
    }),
    columnHelper.display({
      id: "actions",
      header: "",
      size: 10,
      cell: ({ row }) => {
        const contact = row.original;
        const menuItems = createTableItems(contact);

        return (
          <div className="flex justify-center items-center  w-full">
            <TableActionMenu dropdownTitle="Address Options" items={menuItems}>
              <Button
                variant="ghost"
                size="md"
                className="h-8 w-8 p-0 text-grey-70"
              >
                <MoreVertical className="size-4" />
              </Button>
            </TableActionMenu>
          </div>
        );
      }
    })
  ];

  const table = useReactTable({
    columns,
    data: paginatedData,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  return (
    <>
      <TableWrapper>
        <Table>
          <THead>
            {table.getHeaderGroups().map((headerGroup) => (
              <Tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Th key={header.id} header={header} />
                ))}
              </Tr>
            ))}
          </THead>
          <TBody>
            {table.getRowModel().rows.map((row) => (
              <Tr key={row.id} transparent rowHover>
                {row.getVisibleCells().map((cell) => (
                  <Td className="text-grey-20" key={cell.id} cell={cell} />
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>

        {isDeleting && (
          <div className="absolute inset-0 bg-white/50 flex items-center justify-center">
            <Loader2 className="size-6 animate-spin text-grey-50" />
          </div>
        )}

        {contacts.length === 0 && (
          <div className="w-full h-[350px] flex items-center justify-center p-6">
            <div className="flex flex-col items-center opacity-0 animate-fade-in-0.5">
              <div className="w-12 h-12 rounded-full bg-primary-90 flex items-center justify-center mb-2">
                <Icons.DocumentText className="size-7 text-primary-50" />
              </div>
              <span className="text-grey-60 text-sm font-medium max-w-[190px] text-center">
                No saved addresses. Add a new address to get started.
              </span>
            </div>
          </div>
        )}
      </TableWrapper>

      {totalPages > 1 && (
        <div className="my-4">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            setPage={setCurrentPage}
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
