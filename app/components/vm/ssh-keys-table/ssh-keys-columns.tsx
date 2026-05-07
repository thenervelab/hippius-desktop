import { createColumnHelper } from "@tanstack/react-table";
import { SSHKey } from "./index";
import { MoreVertical } from "lucide-react";
import React from "react";
import { Button } from "@/components/ui/button";
import { CopyableCell } from "../../ui/alt-table";
import { formatDate } from "@/app/lib/utils/formatters/formatDate";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Icons } from "../../ui";

const columnHelper = createColumnHelper<SSHKey>();

export const getDesktopColumns = (onDelete?: (sshKey: SSHKey) => void) => [
  columnHelper.accessor("name", {
    header: "KEY NAME",
    cell: (d) => <span className="text-grey-20 text-base">{d.getValue()}</span>,
  }),
  columnHelper.accessor("public_key", {
    header: "PUBLIC KEY",
    cell: (d) => (
      <div className="overflow-hidden">
        <CopyableCell
          title="Copy Public Key"
          toastMessage="Public Key Copied Successfully!"
          copyAbleText={d.getValue()}
          numberOfCharactersFromStartAndEnd={30}
          className=" h-full"
        />
      </div>
    ),
  }),
  columnHelper.accessor("fingerprint", {
    header: "FINGERPRINT",
    cell: (d) => <span className="text-grey-20 text-base">{d.getValue()}</span>,
  }),
  columnHelper.accessor("created", {
    header: "CREATED AT",
    cell: (d) => formatDate(d.getValue()),
  }),
  columnHelper.accessor("last_used", {
    header: "LAST USED",
    cell: (d) => (
      <span>{d.getValue() ? formatDate(d.getValue()) : "Never"}</span>
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
            size="auto"
            className="h-8 w-16 p-0 text-grey-70 action-menu-area"
          >
            <MoreVertical className="size-4" />
          </Button>
        </TableActionMenu>
      );
    },
  }),
];
