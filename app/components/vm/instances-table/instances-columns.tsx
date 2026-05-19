import { createColumnHelper } from "@tanstack/react-table";
import { Instance } from "./index";
import { MoreVertical } from "lucide-react";
import React from "react";
import StatusCell from "./status-cell";
import Link from "next/link";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import { Icons } from "../../ui";
import { parseImageName } from "@/lib/utils/vmUtils";
import { formatDate } from "@/app/lib/utils/formatters/formatDate";
import ImageCell from "./image-cell";
import TemplateCell from "./template-cell";
import { VMFlavorResponse } from "@/app/lib/hooks/api/useVMFlavors";
import { CopyableCell } from "../../ui/alt-table/CopyableCell";

const columnHelper = createColumnHelper<Instance>();

// Format instance name for display - truncate long names
const formatInstanceName = (name: string): string => {
  if (name.length > 20) {
    return `${name.slice(0, 10)}...${name.slice(-7)}`;
  }
  return name;
};

export const getDesktopColumns = (
  flavors: VMFlavorResponse[] | undefined,
  onDelete?: (instance: Instance) => void,
  onStartStop?: (instance: Instance, status: string) => void,
  onReboot?: (instance: Instance) => void,
) => [
  columnHelper.accessor("name", {
    header: "Name",
    cell: (d) => {
      const instance = d.row.original;
      const fullName = d.getValue();
      const displayName = formatInstanceName(fullName);
      return (
        <Link
          href={`/vm/instance-details?instanceId=${instance.id}`}
          className="font-medium text-[12px] tracking-[-0.24px] text-[#1d1d1d] dark:text-white hover:text-primary-50 dark:hover:text-primary-50 transition-colors cursor-pointer block truncate"
          title={fullName}
        >
          {displayName}
        </Link>
      );
    },
    size: 180,
    minSize: 160,
    maxSize: 300,
    meta: {
      cellClassName: "max-w-[300px] min-w-[160px] w-[180px]",
      headerClassName: "min-w-[160px] w-[180px]",
    },
  }),
  columnHelper.accessor("flavor", {
    header: "Template",
    cell: (d) => {
      const flavorName = d.getValue();
      const flavor = flavors?.find(
        (f) => f.name.toLowerCase() === flavorName.toLowerCase(),
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
    header: "Image",
    cell: (d) => {
      return <ImageCell value={parseImageName(d.getValue())} />;
    },
  }),
  columnHelper.accessor("nebula_ip", {
    header: "Nebula IP",
    cell: (d) => {
      const ip = d.getValue();
      if (!ip) {
        return (
          <span className="font-medium text-[12px] tracking-[-0.24px] text-[#1d1d1d] dark:text-white">
            —
          </span>
        );
      }
      return (
        <div className="overflow-hidden">
          <CopyableCell
            title="Copy Nebula IP"
            toastMessage="Nebula IP Copied Successfully!"
            copyAbleText={ip}
            numberOfCharactersFromStartAndEnd={30}
            className="h-full font-medium text-[12px] tracking-[-0.24px] text-[#1d1d1d] dark:text-white"
          />
        </div>
      );
    },
  }),
  columnHelper.accessor("status", {
    header: "Status",
    cell: (d) => <StatusCell value={d.getValue()} />,
  }),
  columnHelper.accessor("created_at", {
    header: "Created At",
    cell: (d) => (
      <span className="font-medium text-[12px] tracking-[-0.24px] text-[#7d7d7d] dark:text-[#a3a3a3] whitespace-nowrap">
        {formatDate(d.getValue())}
      </span>
    ),
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
      const instance = row.original;
      return (
        <div className="flex justify-center">
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
                itemTitle: "Access Console",
                isLink: true,
                href: `/vm/instance-details?instanceId=${instance.id}&tab=console`,
              },
              // {
              //   icon: <Icons.CloudConnection className="size-4" />,
              //   itemTitle: "SSH Connection",
              //   disabled: true,
              //   onItemClick: () => console.log("SSH connection"),
              // },
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
                disabled:
                  instance.status.toLowerCase() !== "running" &&
                  instance.status.toLowerCase() !== "stopped",
                onItemClick: () =>
                  onStartStop && onStartStop(instance, instance.status),
              },
              {
                icon: <Icons.Refresh2 className="size-4" />,
                itemTitle: "Reboot Instance",
                disabled: instance.status.toLowerCase() !== "running",
                onItemClick: () => onReboot && onReboot(instance),
              },
              {
                icon: <Icons.Trash className="size-4" />,
                itemTitle: "Delete Instance",
                onItemClick: () => onDelete && onDelete(instance),
                variant: "destructive",
              },
            ]}
          >
            <button
              type="button"
              aria-label={`Open actions for ${instance.name}`}
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
