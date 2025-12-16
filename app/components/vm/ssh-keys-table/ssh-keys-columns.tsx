import { createColumnHelper } from "@tanstack/react-table";
import { SSHKey } from "./index";
import { MoreVertical } from "lucide-react";
import React from "react";
import { Button } from "@/components/ui/button";
import { CopyableCell } from "../../ui/alt-table";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Icons } from "../../ui";

const columnHelper = createColumnHelper<SSHKey>();

export const getDesktopColumns = (onDelete?: (sshKey: SSHKey) => void) => [
  columnHelper.accessor("keyName", {
    header: "KEY NAME",
    cell: (d) => <span className="text-grey-20 text-base">{d.getValue()}</span>,
  }),
  columnHelper.accessor("sshKey", {
    header: "SSH KEY",
    cell: (d) => (
      <div className="overflow-hidden">
        <CopyableCell
          title="Copy SSH Key"
          toastMessage="SSH Key Copied Successfully!"
          copyAbleText={d.getValue()}
          numberOfCharactersFromStartAndEnd={45}
          className=" h-full"
        />
      </div>
    ),
  }),
  columnHelper.accessor("dateCreated", {
    header: "DATE CREATED",
    cell: (d) => (
      <span className="text-grey-20 text-base ">{d.getValue()}</span>
    ),
  }),
  columnHelper.display({
    id: "actions",
    header: "",
    cell: ({ row }) => {
      const sshKey = row.original;
      return (
        <TableActionMenu
          dropdownTitle="SSH Key Options"
          items={[
            {
              icon: <Icons.Trash className="size-4" />,
              itemTitle: "Delete SSH Key",
              onItemClick: () => onDelete && onDelete(sshKey),
              variant: "destructive",
            },
          ]}
        >
          <Button
            variant="ghost"
            size="md"
            className="h-8 w-16 p-0 text-grey-70 action-menu-area"
          >
            <MoreVertical className="size-4" />
          </Button>
        </TableActionMenu>
      );
    },
  }),
];
