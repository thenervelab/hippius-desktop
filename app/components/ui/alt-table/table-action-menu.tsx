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
    onItemClick?: () => void;
    isLink?: boolean;
    href?: string;
    isVisible?: boolean;
    className?: string;
    variant?: "default" | "destructive";
    disabled?: boolean;
}

interface TableActionMenuProps {
    dropdownTitle: string;
    items: ActionItem[];
    children: React.ReactNode;
}

// Use memo to prevent unnecessary re-renders
const TableActionMenu = memo(function TableActionMenu({
    dropdownTitle,
    items,
    children,
}: TableActionMenuProps) {
    // Memoize the filtered items to prevent recreating the array on each render
    const filteredItems = useMemo(
        () => items.filter((item) => item.isVisible !== false),
        [items]
    );

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)]
         rounded-2 overflow-hidden p-0 min-w-[150px]"
            >
                {/* Dropdown title */}
                <div className="text-xs font-medium !text-grey-40 p-2 border-b border-grey-80 uppercase tracking-wide">
                    {dropdownTitle}
                </div>

                {/* Menu items */}
                {filteredItems.map((item, index) => {
                    const isLast = index === filteredItems.length - 1;
                    const defaultClassName = cn(
                        "flex items-center gap-2 p-2 text-xs font-medium cursor-pointer",
                        !isLast && "border-b border-grey-80",
                        item.variant === "destructive"
                            ? "hover:!text-error-70 !text-error-60"
                            : "hover:!text-grey-40 !text-grey-30",
                        item.disabled && "opacity-60 pointer-events-none"
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
                            onClick={item.onItemClick}
                            className={cn(defaultClassName, item.className)}
                            disabled={item.disabled}
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
