import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ActionItem } from "@/app/components/ui/alt-table/TableActionMenu";

interface InstanceRowContextMenuProps {
  x: number;
  y: number;
  items: ActionItem[];
  onClose: () => void;
}

// Approximate item height (28px) + padding so the viewport clamp keeps
// the whole menu on screen even when opened near the bottom edge.
const ITEM_HEIGHT = 28;
const MENU_VERTICAL_PADDING = 24;
const MENU_WIDTH = 200;

/**
 * Portal-rendered right-click menu for an instances-table row. Shares
 * the same `ActionItem` shape and visual treatment as `TableActionMenu`
 * so the kebab dropdown and the row context menu render identically —
 * including the dimmed-active disabled state.
 */
export default function InstanceRowContextMenu({
  x,
  y,
  items,
  onClose,
}: InstanceRowContextMenuProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const handleClickOutside = () => onClose();
    document.addEventListener("click", handleClickOutside);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);

    // Close on a *second* right-click anywhere else — otherwise the
    // browser's native context menu would re-suppress and the user
    // would see two stacked menus.
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      onClose();
    };
    document.addEventListener("contextmenu", handleContextMenu);

    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [onClose]);

  if (!mounted) return null;

  const visibleItems = items.filter((item) => item.isVisible !== false);
  const estimatedHeight =
    visibleItems.length * ITEM_HEIGHT + MENU_VERTICAL_PADDING;

  const menuStyle = {
    top: `${Math.min(y, window.innerHeight - estimatedHeight)}px`,
    left: `${Math.min(x, window.innerWidth - MENU_WIDTH)}px`,
  };

  return createPortal(
    <div
      className="fixed z-50"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        className="rounded-lg overflow-hidden p-1.5 min-w-[12.5rem]
         bg-white dark:bg-black-500
         border border-grey-80 dark:border-black-300
         shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]"
      >
        {visibleItems.map((item, index) => {
          // Mirror the styling used inside TableActionMenu so disabled
          // rows keep the active text/icon color and only lose hover
          // affordances + interactivity.
          const variantTextClass =
            item.variant === "destructive"
              ? "!text-error-60 dark:!text-error-70"
              : "!text-[#52525C] dark:!text-grey-dark-200";
          const variantHoverClass =
            item.variant === "destructive"
              ? "hover:!text-error-70 hover:bg-error-100/40 dark:hover:!text-error-60 dark:hover:bg-error-70/10"
              : "hover:!text-grey-10 hover:bg-grey-90 dark:hover:!text-grey-light-100 dark:hover:bg-white/5";

          const itemClass = cn(
            "flex items-center gap-2.5 px-1.5 py-1.5 rounded-md w-full text-left",
            variantTextClass,
            item.disabled
              ? "opacity-50 cursor-not-allowed pointer-events-none"
              : cn("cursor-pointer", variantHoverClass),
            item.className,
          );

          const itemContent = (
            <>
              {item.icon}
              <span className="font-geist text-[14px] font-medium leading-4 tracking-[-0.4px] line-clamp-1 flex-[1_0_0] overflow-hidden text-ellipsis">
                {item.itemTitle}
              </span>
            </>
          );

          if (item.isLink && item.href && !item.disabled) {
            return (
              <Link
                href={item.href}
                key={index}
                className={itemClass}
                onClick={() => {
                  item.onItemClick?.();
                  onClose();
                }}
                title={item.tooltip}
              >
                {itemContent}
              </Link>
            );
          }

          return (
            <button
              key={index}
              type="button"
              className={itemClass}
              disabled={item.disabled}
              title={item.tooltip}
              onClick={(e) => {
                if (item.disabled) return;
                item.onItemClick?.(e);
                onClose();
              }}
            >
              {itemContent}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
