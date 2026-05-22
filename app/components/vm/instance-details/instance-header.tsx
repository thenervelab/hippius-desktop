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
      icon: <Icons.Dashboard className="size-3.5" />,
    },
    {
      tabName: "Console",
      icon: <Icons.DocumentCode className="size-3.5" />,
    },
  ];

  return (
    <div className="w-full">
      <div className="flex @sm:justify-between @sm:items-center mb-3 flex-col gap-2 @sm:flex-row">
        <div className="flex items-center gap-2 text-base @sm:text-[1.375rem] font-medium  text-black-700 dark:text-grey-light-100">
          <Link
            href="/vm"
            aria-label="Go back"
            className="text-black-600/50 hover:text-grey-40 dark:text-grey-light-100 dark:hover:text-grey-dark-400"
          >
            <Icons.ArrowLeft className="size-5" />
          </Link>
          <h1 className="text-nowrap">Instance Details</h1>
          <span className="text-grey-60">-</span>
          {isLoading ? (
            <Skeleton className="!h-[1.75rem] !w-[9.375rem] dark:!bg-black-300" />
          ) : (
            <span className="text-grey-60 truncate">{instanceName}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onRefresh && (
            <RefreshButton
              refetching={isRefetching}
              onClick={onRefresh}
              className="!w-[26px] !h-[26px]"
              iconClassName="!size-[14px]"
            />
          )}
          <TabList
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={onTabChange}
            gap="gap-[3.831px]"
            width="w-auto"
            height="h-6"
            tabItemPaddingX="px-[6.13px]"
            textClassName="font-medium text-[12px] tracking-[-0.24px] leading-[1.109]"
            className="p-[3.065px] dark:!bg-black-600"
          />
        </div>
      </div>
    </div>
  );
};

export default InstanceHeader;
