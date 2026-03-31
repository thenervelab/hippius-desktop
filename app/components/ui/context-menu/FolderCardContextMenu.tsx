import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface FolderCardMenuItem {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive";
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
    top: `${Math.min(y, window.innerHeight - items.length * 36 - 16)}px`,
    left: `${Math.min(x, window.innerWidth - 200)}px`,
  };

  return createPortal(
    <div
      className="fixed z-50"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] rounded-lg overflow-hidden p-0 min-w-[9.375rem]">
        <div className="flex flex-col">
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            const isDestructive = item.variant === "destructive";
            return (
              <button
                key={i}
                className={
                  isDestructive
                    ? `flex items-center gap-2 p-2 text-xs font-medium hover:!text-error-70 !text-error-60 hover:bg-grey-90 cursor-pointer${!isLast ? " border-b border-grey-80" : ""}`
                    : `flex items-center gap-2 p-2 text-xs font-medium hover:!text-grey-40 !text-grey-30 hover:bg-grey-90 cursor-pointer${!isLast ? " border-b border-grey-80" : ""}`
                }
                onClick={() => {
                  item.onClick();
                  onClose();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
}
