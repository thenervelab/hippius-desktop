import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Upload, FolderPlus, FolderSync } from "lucide-react";

interface BackgroundContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onUploadFile: () => void;
  onAddFolder: () => void;
  onAddSyncFolder?: () => void;
}

export default function BackgroundContextMenu({
  x,
  y,
  onClose,
  onUploadFile,
  onAddFolder,
  onAddSyncFolder,
}: BackgroundContextMenuProps) {
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

  if (!mounted) return null;

  const menuStyle = {
    top: `${Math.min(y, window.innerHeight - 180)}px`,
    left: `${Math.min(x, window.innerWidth - 200)}px`,
  };

  const menuItemClass =
    "flex items-center gap-2 p-2 text-xs font-medium !text-grey-30 hover:!text-grey-40 hover:bg-grey-90 cursor-pointer";

  return createPortal(
    <div
      className="fixed z-50"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] rounded-lg overflow-hidden p-0 min-w-[9.375rem]">
        <div className="flex flex-col">
          <button
            className={`${menuItemClass} border-b border-grey-80`}
            onClick={() => {
              onUploadFile();
              onClose();
            }}
          >
            <Upload className="size-4" />
            <span>Upload File</span>
          </button>

          <button
            className={`${menuItemClass} border-b border-grey-80`}
            onClick={() => {
              onAddFolder();
              onClose();
            }}
          >
            <FolderPlus className="size-4" />
            <span>Add Folder</span>
          </button>

          {onAddSyncFolder && (
            <button
              className={menuItemClass}
              onClick={() => {
                onAddSyncFolder();
                onClose();
              }}
            >
              <FolderSync className="size-4" />
              <span>Add Sync Folder</span>
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
