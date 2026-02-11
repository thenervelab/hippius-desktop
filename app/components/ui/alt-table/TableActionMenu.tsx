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
        className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)]
         rounded-2 overflow-hidden p-0 min-w-[150px]"
      >
        {/* Dropdown title */}
        {dropdownTitle && (
          <div className="text-xs font-medium !text-grey-40 p-2 border-b border-grey-80 uppercase tracking-wide">
            {dropdownTitle}
          </div>
        )}

        {/* Menu items */}
        {filteredItems.map((item, index) => {
          const isLast = index === filteredItems.length - 1;
          const defaultClassName = cn(
            "flex items-center gap-2 p-2 text-xs font-medium",
            !isLast && "border-b border-grey-80",
            item.disabled
              ? "opacity-60 cursor-not-allowed pointer-events-none"
              : cn(
                "cursor-pointer",
                item.variant === "destructive"
                  ? "hover:!text-error-70 !text-error-60"
                  : "hover:!text-grey-40 !text-grey-30"
              )
          );

          const itemContent = (
            <>
              {item.icon}
              <span>{item.itemTitle}</span>
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
