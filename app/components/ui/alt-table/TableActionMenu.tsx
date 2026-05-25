import React, { memo, useMemo } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ActionItem {
  icon: React.ReactNode;
  itemTitle: React.ReactNode;
  onItemClick?: (e?: React.MouseEvent) => void;
  isLink?: boolean;
  href?: string;
  isVisible?: boolean;
  className?: string;
  variant?: "default" | "destructive";
  disabled?: boolean;
  tooltip?: string;
}

interface TableActionMenuProps {
  dropdownTitle: string;
  items: ActionItem[];
  children: React.ReactNode;
  dropDownMenuTriggerClass?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

// Use memo to prevent unnecessary re-renders
const TableActionMenu = memo(function TableActionMenu({
  dropdownTitle,
  items,
  children,
  dropDownMenuTriggerClass,
  open,
  onOpenChange,
  disabled = false,
}: TableActionMenuProps) {
  // Memoize the filtered items to prevent recreating the array on each render
  const filteredItems = useMemo(
    () => items.filter((item) => item.isVisible !== false),
    [items]
  );

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        className={dropDownMenuTriggerClass}
        asChild
        disabled={disabled}
      >
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="rounded-lg overflow-hidden p-1.5 min-w-[12.5rem]
         bg-white dark:bg-black-500
         border border-grey-80 dark:border-black-300
         shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]"
      >
        {/* Dropdown title */}
        {dropdownTitle && (
          <div className="text-xs font-medium !text-grey-40 dark:!text-grey-dark-700 px-2 pt-1 pb-2 uppercase tracking-wide">
            {dropdownTitle}
          </div>
        )}

        {/* Menu items */}
        {filteredItems.map((item, index) => {
          // Disabled items keep the active variant's text/icon color so they
          // remain legible (just dimmed via opacity), and lose only the
          // interactive affordances — hover, cursor, pointer events.
          const variantTextClass =
            item.variant === "destructive"
              ? "!text-error-60 dark:!text-error-70"
              : "!text-[#52525C] dark:!text-grey-dark-200";
          const variantHoverClass =
            item.variant === "destructive"
              ? "hover:!text-error-70 hover:bg-error-100/40 dark:hover:!text-error-60 dark:hover:bg-error-70/10"
              : "hover:!text-grey-10 hover:bg-grey-90 dark:hover:!text-grey-light-100 dark:hover:bg-white/5";

          const defaultClassName = cn(
            "flex items-center gap-2.5 px-1.5 py-1.5 rounded-md",
            variantTextClass,
            item.disabled
              ? "opacity-50 cursor-not-allowed pointer-events-none"
              : cn("cursor-pointer", variantHoverClass)
          );

          const itemContent = (
            <>
              {item.icon}
              <span className="font-geist text-[14px] font-medium leading-4 tracking-[-0.4px] line-clamp-1 flex-[1_0_0] overflow-hidden text-ellipsis">
                {item.itemTitle}
              </span>
            </>
          );

          if (item.isLink && item.href) {
            return (
              <Link href={item.href} key={index}>
                <DropdownMenuItem
                  className={cn(defaultClassName, item.className)}
                >
                  {itemContent}
                </DropdownMenuItem>
              </Link>
            );
          }

          return (
            <DropdownMenuItem
              key={index}
              onClick={(e) => {
                if (item.disabled) {
                  e.preventDefault();
                  e.stopPropagation();
                  // Force close the menu for disabled items
                  onOpenChange?.(false);
                  return false;
                }
                item.onItemClick?.(e);
              }}
              onMouseDown={(e) => {
                if (item.disabled) {
                  e.preventDefault();
                  e.stopPropagation();
                  return false;
                }
              }}
              className={cn(defaultClassName, item.className)}
              disabled={item.disabled}
              title={item.tooltip}
            >
              {itemContent}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

export default TableActionMenu;
