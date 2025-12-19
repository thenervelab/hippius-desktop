"use client";
import React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button/NewButton";
import { Icons } from "../../ui";
import TabList, { TabOption } from "../../ui/tabs/TabList";
import TableActionMenu from "../../ui/alt-table/TableActionMenu";
import Skeleton from "@/components/ui/skeleton";

interface InstanceHeaderProps {
  instanceName?: string;
  instanceStatus?: string;
  activeTab: string;
  onTabChange: (tabName: string) => void;
  onChangeImage?: () => void;
  onDeleteInstance?: () => void;
  onStartStop?: () => void;
  onReboot?: () => void;
  onReinstall?: () => void;
  onRefresh?: () => void;
  isLoading?: boolean;
}

const InstanceHeader: React.FC<InstanceHeaderProps> = ({
  instanceName,
  activeTab,
  instanceStatus,
  onTabChange,
  onChangeImage,
  onDeleteInstance,
  onStartStop,
  onReboot,
  onReinstall,
  onRefresh,
  isLoading = false,
}) => {
  const tabs: TabOption[] = [
    {
      tabName: "Dashboard",
      icon: <Icons.Dashboard className="size-4" />,
    },
    {
      tabName: "VNC Console",
      icon: <Icons.DocumentCode className="size-4" />,
    },
  ];

  return (
    <div className="w-full">
      <div className="flex sm:justify-between sm:items-center mb-4 sm:mb-6 flex-col gap-2 sm:flex-row">
        <div className="flex items-center gap-2 text-base sm:text-[22px] font-medium text-grey-10">
          <Link href="/vm" className="text-grey-10 hover:text-grey-40">
            <Icons.ArrowLeft className="size-6" />
          </Link>
          <h1 className="text-nowrap">Instance Details</h1>
          <span className="text-grey-60">-</span>
          {isLoading ? (
            <Skeleton className="!h-[28px] !w-[150px]" />
          ) : (
            <span className="text-grey-60 truncate">{instanceName}</span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="border border-grey-80 rounded p-1 bg-grey-100">
            <TabList
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={onTabChange}
              className="w-full "
              width="w-full sm:min-w-[148px]"
            />
          </div>
          {onRefresh && (
            <Button
              variant="ghost"
              size="noStyle"
              className="border border-grey-80 text-grey-10 p-2"
              onClick={onRefresh}
              title="Refresh instance details"
            >
              <Icons.Refresh className="size-4" />
            </Button>
          )}
          <div className="hidden sm:block">
            <TableActionMenu
              dropdownTitle="Instance Options"
              disabled={isLoading}
              items={[
                {
                  icon:
                    instanceStatus === "Stopped" ? (
                      <Icons.PlayCircle className="size-4" />
                    ) : (
                      <Icons.StopCircle className="size-4" />
                    ),
                  itemTitle:
                    instanceStatus === "Stopped"
                      ? "Start Instance"
                      : "Stop Instance",
                  onItemClick: () => onStartStop && onStartStop(),
                },
                {
                  icon: <Icons.Refresh2 className="size-4" />,
                  itemTitle: "Reboot Instance",
                  onItemClick: () => onReboot && onReboot(),
                },
                {
                  icon: <Icons.Refresh className="size-4" />,
                  itemTitle: "Reinstall Instance",
                  onItemClick: () => onReinstall && onReinstall(),
                },
                {
                  icon: <Icons.CpuCharge className="size-4" />,
                  itemTitle: "Change Image",
                  onItemClick: () => onChangeImage && onChangeImage(),
                },
                {
                  icon: <Icons.Trash className="size-4" />,
                  itemTitle: "Delete Instance",
                  onItemClick: () => onDeleteInstance && onDeleteInstance(),
                  variant: "destructive",
                },
              ]}
            >
              <Button
                variant="ghost"
                size="noStyle"
                className="border border-grey-80 text-grey-10 p-2 flex gap-2 text-sm"
              >
                <Icons.MoreCircle className="size-4" />
                <span>Instance Options</span>
              </Button>
            </TableActionMenu>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InstanceHeader;
