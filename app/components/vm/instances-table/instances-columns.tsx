import { createColumnHelper } from "@tanstack/react-table";
import { Instance } from "./index";
import { MoreVertical } from "lucide-react";
import React from "react";
import TemplateCell from "./template-cell";
import ImageCell from "./image-cell";
import StatusCell from "./status-cell";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Icons } from "../../ui";

const columnHelper = createColumnHelper<Instance>();

export const getDesktopColumns = (
  onDelete?: (instance: Instance) => void,
  onStartStop?: (instance: Instance, status: string) => void,
  onReboot?: (instance: Instance) => void,
  onReinstall?: (instance: Instance) => void
) => [
  columnHelper.accessor("name", {
    header: "NAME",
    cell: (d) => {
      const instance = d.row.original;
      return (
        <Link
          href={`/dashboard/vm/view/${instance.id}`}
          className="text-grey-20 text-base hover:text-primary-50 transition-colors cursor-pointer"
        >
          {d.getValue()}
        </Link>
      );
    },
  }),
  columnHelper.accessor("template", {
    header: "MODELS",
    cell: (d) => <TemplateCell value={d.getValue()} />,
  }),
  columnHelper.accessor("image", {
    header: "IMAGE",
    cell: (d) => <ImageCell value={d.getValue()} />,
  }),
  columnHelper.accessor("ipAddress", {
    header: "IP ADDRESS",
    cell: (d) => <span className="text-grey-20 text-base">{d.getValue()}</span>,
  }),
  columnHelper.accessor("status", {
    header: "STATUS",
    cell: (d) => <StatusCell value={d.getValue()} />,
  }),
  columnHelper.display({
    id: "actions",
    header: "",
    cell: ({ row }) => {
      const instance = row.original;
      return (
        <TableActionMenu
          dropdownTitle="Instance Options"
          items={[
            {
              icon: <Icons.Code className="size-4" />,
              itemTitle: "Instance Details",
              isLink: true,
              href: `/dashboard/vm/view/${instance.id}`,
            },
            {
              icon: <Icons.CodeCircle className="size-4" />,
              itemTitle: "VNC Console (Ready)",
              isLink: true,
              href: `/dashboard/vm/view/${instance.id}?tab=vnc-console`,
            },
            {
              icon: <Icons.CloudConnection className="size-4" />,
              itemTitle: "SSH Connection",
              onItemClick: () => console.log("SSH connection"),
            },
            {
              icon:
                instance.status === "Stopped" ? (
                  <Icons.PlayCircle className="size-4" />
                ) : (
                  <Icons.StopCircle className="size-4" />
                ),
              itemTitle:
                instance.status === "Stopped"
                  ? "Start Instance"
                  : "Stop Instance",
              onItemClick: () =>
                onStartStop && onStartStop(instance, instance.status),
            },
            {
              icon: <Icons.Refresh2 className="size-4" />,
              itemTitle: "Reboot Instance",
              onItemClick: () => onReboot && onReboot(instance),
            },
            {
              icon: <Icons.Refresh className="size-4" />,
              itemTitle: "Reinstall Instance",
              onItemClick: () => onReinstall && onReinstall(instance),
            },
            {
              icon: <Icons.Trash className="size-4" />,
              itemTitle: "Delete Instance",
              onItemClick: () => onDelete && onDelete(instance),
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
