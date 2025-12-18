import { createColumnHelper } from "@tanstack/react-table";
import { Instance } from "./index";
import { MoreVertical } from "lucide-react";
import React from "react";
import StatusCell from "./status-cell";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Icons } from "../../ui";
import { formatDate } from "@/app/lib/utils/formatters/formatDate";
import ImageCell from "./image-cell";
import TemplateCell from "./template-cell";
import { VMFlavorResponse } from "@/app/lib/hooks/api/useVMFlavors";

const columnHelper = createColumnHelper<Instance>();

export const getDesktopColumns = (
  flavors: VMFlavorResponse[] | undefined,
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
          href={`/vm/instance-details?instanceId=${instance.id}`}
          className="text-grey-20 text-base hover:text-primary-50 transition-colors cursor-pointer"
        >
          {d.getValue()}
        </Link>
      );
    },
  }),
  columnHelper.accessor("flavor", {
    header: "TEMPLATE",
    cell: (d) => {
      const flavorName = d.getValue();
      const flavor = flavors?.find(
        (f) => f.name.toLowerCase() === flavorName.toLowerCase()
      );

      if (!flavor) {
        return <span className="text-grey-60 text-xs">{flavorName}</span>;
      }

      return (
        <TemplateCell
          value={{
            name: flavor.display_name,
            cpu: `${flavor.cpu_cores} vCore${flavor.cpu_cores > 1 ? "s" : ""}`,
            ram: `${(flavor.memory_mb / 1024).toFixed(0)} GB`,
            gpu: `${flavor.data_disk_gb} GB Storage`,
          }}
        />
      );
    },
  }),
  columnHelper.accessor("image", {
    header: "IMAGE",
    cell: (d) => {
      const imageName = d.getValue();
      // Extract OS and version from image name
      let os: "AlmaLinux" | "Debian" | "Rocky Linux" | "Ubuntu";
      let version: string;

      if (imageName.startsWith("AlmaLinux")) {
        os = "AlmaLinux";
        version = imageName.replace("AlmaLinux ", "");
      } else if (imageName.startsWith("Debian")) {
        os = "Debian";
        version = imageName.replace("Debian ", "");
      } else if (imageName.startsWith("Rocky Linux")) {
        os = "Rocky Linux";
        version = imageName.replace("Rocky Linux ", "");
      } else if (imageName.startsWith("Ubuntu")) {
        os = "Ubuntu";
        version = imageName.replace("Ubuntu ", "");
      } else {
        // Fallback for unknown OS
        const parts = imageName.split(" ");
        os = "Rocky Linux"; // Default fallback
        version = parts.slice(1).join(" ") || imageName;
      }

      return <ImageCell value={{ os, version }} />;
    },
  }),
  columnHelper.accessor("public_ip", {
    header: "PUBLIC IP",
    cell: (d) => (
      <span className="text-grey-20 text-base">{d.getValue() || "—"}</span>
    ),
  }),
  columnHelper.accessor("nebula_ip", {
    header: "NEBULA IP",
    cell: (d) => (
      <span className="text-grey-20 text-base">{d.getValue() || "—"}</span>
    ),
  }),
  columnHelper.accessor("status", {
    header: "STATUS",
    cell: (d) => <StatusCell value={d.getValue()} />,
  }),
  columnHelper.accessor("created_at", {
    header: "CREATED AT",
    cell: (d) => formatDate(d.getValue()),
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
              href: `/vm/instance-details?instanceId=${instance.id}`,
            },
            {
              icon: <Icons.CodeCircle className="size-4" />,
              itemTitle: "VNC Console (Ready)",
              isLink: true,
              href: `/vm/instance-details?instanceId=${instance.id}&tab=vnc-console`,
            },
            {
              icon: <Icons.CloudConnection className="size-4" />,
              itemTitle: "SSH Connection",
              onItemClick: () => console.log("SSH connection"),
            },
            {
              icon:
                instance.status.toLowerCase() === "stopped" ? (
                  <Icons.PlayCircle className="size-4" />
                ) : (
                  <Icons.StopCircle className="size-4" />
                ),
              itemTitle:
                instance.status.toLowerCase() === "stopped"
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
