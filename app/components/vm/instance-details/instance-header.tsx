"use client";
import React from "react";
import Link from "next/link";
import { Icons } from "../../ui";
import TabList, { TabOption } from "../../ui/tabs/TabList";
import Skeleton from "@/components/ui/skeleton";
import RefreshButton from "../../ui/refresh-button";

interface InstanceHeaderProps {
  instanceName?: string;
  activeTab: string;
  onTabChange: (tabName: string) => void;
  isLoading?: boolean;
  onRefresh?: () => void;
  isRefetching?: boolean;
}

const InstanceHeader: React.FC<InstanceHeaderProps> = ({
  instanceName,
  activeTab,
  onTabChange,
  isLoading = false,
  onRefresh,
  isRefetching = false,
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
          {onRefresh && (
            <RefreshButton refetching={isRefetching} onClick={onRefresh} />
          )}
          <div className="border border-grey-80 rounded p-1 bg-grey-100">
            <TabList
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={onTabChange}
              className="w-full "
              width="w-full sm:min-w-[148px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default InstanceHeader;
