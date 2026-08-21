import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface FolderCardMenuItem {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive";
  /** Renders dimmed and inert; `tooltip` (native `title`) states why. */
  disabled?: boolean;
  tooltip?: string;
}

interface FolderCardContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  items: FolderCardMenuItem[];
}

export default function FolderCardContextMenu({
  x,
  y,
  onClose,
  items,
}: FolderCardContextMenuProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const handleClickOutside = () => onClose();
    document.addEventListener("click", handleClickOutside);

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  if (!mounted || items.length === 0) return null;

  const menuStyle = {
    top: `${Math.min(y, window.innerHeight - items.length * 44 - 16)}px`,
    left: `${Math.min(x, window.innerWidth - 220)}px`,
  };

  return createPortal(
    <div
      className="fixed z-50"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          "rounded-lg overflow-hidden p-1.5 min-w-[12.5rem]",
          "bg-white dark:bg-black-500",
          "border border-grey-80 dark:border-black-300",
          "shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]"
        )}
      >
        <div className="flex flex-col">
          {items.map((item, i) => {
            const isDestructive = item.variant === "destructive";
            return (
              <button
                key={i}
                // Disabled items keep the variant's text color, dimmed, and
                // lose only the interactive affordances. Deliberately no
                // `pointer-events-none`: it would stop the element from ever
                // being a hover target, making the `title` tooltip
                // unreachable (the FileContextMenu Rename-row pattern).
                className={cn(
                  "flex items-center gap-2.5 px-1.5 py-1.5 rounded-md text-left w-full",
                  isDestructive
                    ? "!text-error-60 dark:!text-error-70"
                    : "!text-[#52525C] dark:!text-grey-dark-200",
                  item.disabled
                    ? "opacity-50 cursor-not-allowed"
                    : cn(
                        "cursor-pointer",
                        isDestructive
                          ? "hover:!text-error-70 hover:bg-error-100/40 dark:hover:!text-error-60 dark:hover:bg-error-70/10"
                          : "hover:!text-grey-10 hover:bg-grey-90 dark:hover:!text-grey-light-100 dark:hover:bg-white/5"
                      )
                )}
                disabled={item.disabled}
                title={item.tooltip}
                onClick={() => {
                  if (item.disabled) return;
                  item.onClick();
                  onClose();
                }}
              >
                {item.icon}
                <span className="font-geist text-[14px] font-medium leading-4 tracking-[-0.4px] line-clamp-1 flex-[1_0_0] overflow-hidden text-ellipsis">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}
