"use client";

import React from "react";
import { InView } from "react-intersection-observer";
import {
  AbstractIconWrapper,
  H4,
  RevealTextLine,
  Select,
  Icons,
  SearchInput,
} from "@/components/ui";
import { cn } from "@/app/lib/utils";
import { Option } from "@/components/ui/select";
import { IconComponent } from "@/app/lib/types";
import Link from "next/link";

interface TableToolbarProps {
  title?: string;
  pageLink?: string;
  icon: IconComponent;
  showSearch?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: Option[];
  onRefresh?: () => void;
  onAutoRefreshClick?: () => void;
  autoRefresh?: boolean;
  refreshing?: boolean;
  customFilters?: React.ReactNode;
  size?: string;
  removeMarginBottom?: boolean;
}

const defaultOptions: Option[] = [
  { value: "10", label: "10 Rows" },
  { value: "25", label: "25 Rows" },
  { value: "50", label: "50 Rows" },
  { value: "100", label: "100 Rows" },
];

export const TableToolbar: React.FC<TableToolbarProps> = ({
  title,
  pageLink,
  icon: Icon,
  showSearch = true,
  searchValue = "",
  onSearchChange,
  searchPlaceholder = "Search",
  pageSize,
  onPageSizeChange,
  pageSizeOptions = defaultOptions,
  onRefresh,
  onAutoRefreshClick,
  autoRefresh,
  refreshing,
  customFilters,
  removeMarginBottom = false,
  size = "md",
}) => {
  return (
    <InView triggerOnce threshold={0.2}>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className={cn("flex sm:items-center justify-between gap-2 mb-4", {
            "flex-col sm:flex-row": showSearch,
            "mb-4": !removeMarginBottom,
            "mb-0": removeMarginBottom,
          })}
        >
          {/* Left side (title + desktop auto-refresh) */}
          {title && (
            <div className="flex items-center group">
              <AbstractIconWrapper
                key={pageSize}
                className={cn(
                  "size-10 opacity-0 translate-y-7 duration-500 transition-transform",
                  inView && "opacity-100 translate-y-0",
                  size === "sm" && "size-8"
                )}
              >
                <Icon className="relative size-6 text-primary-50" />
              </AbstractIconWrapper>

              {pageLink ? (
                <Link href={pageLink}>
                  <H4
                    size="sm"
                    className="max-w-screen-sm text-center ml-2 transition-colors hover:text-primary-50"
                  >
                    <RevealTextLine rotate reveal={inView}>
                      {title}
                    </RevealTextLine>
                  </H4>
                </Link>
              ) : (
                <H4
                  size="sm"
                  className={cn(
                    "max-w-screen-sm text-center ml-2 transition-colors",
                    size === "sm" && "!text-lg sm:!text-[24px]"
                  )}
                >
                  <RevealTextLine rotate reveal={inView}>
                    {title}
                  </RevealTextLine>
                </H4>
              )}

              {onAutoRefreshClick && (
                <button
                  onClick={onAutoRefreshClick}
                  className={cn(
                    "flex sm:hidden items-center font-medium gap-2 text-sm ml-auto truncate min-w-fit opacity-0 translate-y-4 duration-500 delay-200",
                    inView && "opacity-100 translate-y-0"
                  )}
                >
                  <span className="size-5 min-w-5 flex items-center justify-center border border-primary-50 rounded-md">
                    <Icons.Check
                      className={cn(
                        "size-5 scale-0 duration-300 text-primary-50",
                        !!autoRefresh && "scale-100"
                      )}
                    />
                  </span>
                  <span>Auto Refresh</span>
                </button>
              )}
            </div>
          )}

          {/* Right side (mobile auto-refresh + search + refresh + custom filters + page-size) */}
          <div className="flex items-center gap-4">
            {/* mobile auto-refresh below search */}
            {onAutoRefreshClick && (
              <button
                onClick={onAutoRefreshClick}
                className={cn(
                  "hidden sm:flex items-center font-medium gap-2 text-sm truncate min-w-fit opacity-0 translate-y-4 duration-500 delay-200",
                  inView && "opacity-100 translate-y-0"
                )}
              >
                <span className="size-5 min-w-5 flex items-center justify-center border border-primary-50 rounded-md">
                  <Icons.Check
                    className={cn(
                      "size-5 scale-0 duration-300 text-primary-50",
                      !!autoRefresh && "scale-100"
                    )}
                  />
                </span>
                <span>Auto Refresh</span>
              </button>
            )}

            {showSearch && onSearchChange && (
              <SearchInput
                value={searchValue}
                onChange={onSearchChange}
                placeholder={searchPlaceholder}
                inView={inView}
              />
            )}

            {onRefresh && (
              <div
                className={cn(
                  "opacity-0 translate-y-4 duration-500 delay-300",
                  inView && "opacity-100 translate-y-0"
                )}
              >
                <button
                  onClick={onRefresh}
                  className="p-2 w-8 h-8 rounded flex items-center justify-center border border-grey-80 bg-grey-100 hover:bg-grey-80 hover:border-grey-70 hover:scale-105 active:scale-95 transition-all"
                  title="Refresh"
                >
                  <Icons.Refresh
                    className={cn(
                      "w-4 h-4 text-grey-10 duration-500",
                      refreshing && "text-primary-70 rotate-90"
                    )}
                  />
                </button>
              </div>
            )}

            {onPageSizeChange && pageSize !== undefined && (
              <div
                className={cn(
                  "opacity-0 translate-y-4 duration-500 delay-400 hover:opacity-90 transition-opacity",
                  inView && "opacity-100 translate-y-0"
                )}
              >
                <Select
                  options={pageSizeOptions}
                  value={pageSize.toString()}
                  onValueChange={(val) => onPageSizeChange(Number(val))}
                />
              </div>
            )}

            {/* Custom filters */}
            {customFilters && (
              <div
                className={cn(
                  "opacity-0 translate-y-4 duration-500 delay-400 hover:opacity-90 transition-opacity",
                  inView && "opacity-100 translate-y-0"
                )}
              >
                {customFilters}
              </div>
            )}
          </div>
        </div>
      )}
    </InView>
  );
};
