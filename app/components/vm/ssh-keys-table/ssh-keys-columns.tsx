import { createColumnHelper } from "@tanstack/react-table";
import { SSHKey } from "./index";
import { MoreVertical } from "lucide-react";
import React from "react";
import { CopyableCell } from "../../ui/alt-table";
import { formatDate } from "@/app/lib/utils/formatters/formatDate";
import TableActionMenu, {
  type ActionItem,
} from "../../ui/alt-table/TableActionMenu";
import { Icons } from "../../ui";

const columnHelper = createColumnHelper<SSHKey>();

/**
 * Items shown in BOTH the kebab dropdown and the right-click context
 * menu for an SSH key row. Extracted so the two menus stay in lockstep
 * — every entry added/disabled here automatically shows up in both.
 */
export function buildSSHKeyMenuItems(
  sshKey: SSHKey,
  handlers: { onDelete?: (sshKey: SSHKey) => void },
): ActionItem[] {
  const { onDelete } = handlers;
  return [
    {
      icon: <Icons.Trash className="size-4" />,
      itemTitle: "Delete SSH Key",
      onItemClick: () => onDelete && onDelete(sshKey),
      variant: "destructive",
    },
  ];
}

export const getDesktopColumns = (onDelete?: (sshKey: SSHKey) => void) => [
  columnHelper.accessor("name", {
    header: "Key Name",
    cell: (d) => {
      const fullName = d.getValue();
      return (
        <span
          className="font-medium text-[12px] tracking-[-0.24px] text-[#1d1d1d] dark:text-white block truncate"
          title={fullName}
        >
          {fullName}
        </span>
      );
    },
    size: 180,
    minSize: 160,
    maxSize: 240,
    meta: {
      cellClassName: "max-w-[240px] min-w-[160px] w-[180px]",
      headerClassName: "min-w-[160px] w-[180px]",
    },
  }),
  columnHelper.accessor("public_key", {
    header: "Public Key",
    cell: (d) => (
      <div className="overflow-hidden">
        <CopyableCell
          title="Copy Public Key"
          toastMessage="Public Key Copied Successfully!"
          copyAbleText={d.getValue()}
          numberOfCharactersFromStartAndEnd={30}
          className="h-full font-medium text-[12px] tracking-[-0.24px]"
          textColor="text-[#1d1d1d] dark:text-white"
        />
      </div>
    ),
    size: 320,
    minSize: 240,
    meta: {
      cellClassName: "min-w-[240px] w-[320px]",
      headerClassName: "min-w-[240px] w-[320px]",
    },
  }),
  columnHelper.accessor("fingerprint", {
    header: "Fingerprint",
    cell: (d) => (
      <div className="overflow-hidden">
        <CopyableCell
          title="Copy Fingerprint"
          toastMessage="Fingerprint Copied Successfully!"
          copyAbleText={d.getValue()}
          numberOfCharactersFromStartAndEnd={30}
          className="h-full font-medium text-[12px] tracking-[-0.24px]"
          textColor="text-[#1d1d1d] dark:text-white"
        />
      </div>
    ),
    size: 220,
    minSize: 180,
    meta: {
      cellClassName: "min-w-[180px] w-[220px]",
      headerClassName: "min-w-[180px] w-[220px]",
    },
  }),
  columnHelper.accessor("created", {
    header: "Created At",
    cell: (d) => (
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#7d7d7d] dark:text-[#a3a3a3] whitespace-nowrap">
        {formatDate(d.getValue())}
      </span>
    ),
    size: 130,
    minSize: 120,
    meta: {
      cellClassName: "min-w-[120px] w-[130px]",
      headerClassName: "min-w-[120px] w-[130px]",
    },
  }),
  columnHelper.accessor("last_used", {
    header: "Last Used",
    cell: (d) => {
      const value = d.getValue();
      return (
        <span className="font-medium text-[12px] tracking-[-0.24px] text-[#7d7d7d] dark:text-[#a3a3a3] whitespace-nowrap">
          {value ? formatDate(value) : "Never"}
        </span>
      );
    },
    size: 130,
    minSize: 120,
    meta: {
      cellClassName: "min-w-[120px] w-[130px]",
      headerClassName: "min-w-[120px] w-[130px]",
    },
  }),
  columnHelper.display({
    id: "actions",
    header: "",
    size: 35,
    minSize: 35,
    maxSize: 35,
    meta: {
      cellClassName: "w-[35px] min-w-[35px] max-w-[35px] px-0",
      headerClassName: "w-[35px] min-w-[35px] max-w-[35px] px-0",
    },
    cell: ({ row }) => {
      const sshKey = row.original;
      return (
        <div className="flex justify-center">
          <TableActionMenu
            dropdownTitle="SSH Key Options"
            items={buildSSHKeyMenuItems(sshKey, { onDelete })}
          >
            <button
              type="button"
              aria-label={`Open actions for ${sshKey.name}`}
              className="inline-flex size-5 items-center justify-center rounded-[6px] text-[#989898] transition-colors hover:bg-grey-90 hover:text-grey-20 dark:text-grey-dark-700 dark:hover:bg-black-primary-bg dark:hover:text-grey-dark-200 action-menu-area"
            >
              <MoreVertical className="size-4" />
            </button>
          </TableActionMenu>
        </div>
      );
    },
  }),
];
