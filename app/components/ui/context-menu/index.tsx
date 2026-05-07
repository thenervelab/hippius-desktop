import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Link2, Trash2, FolderOpen } from "lucide-react";
import { Icons } from "@/components/ui";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { toast } from "sonner";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import Link from "next/link";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { Folder } from "@/components/ui/icons";
import cn from "@/app/lib/utils/cn";
import { shareFeatureEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";

const getFileManagerLabel = () => {
  if (typeof navigator !== "undefined" && /win/i.test(navigator.platform)) return "Explorer";
  return "Finder";
};

interface ContextMenuProps {
  x: number;
  y: number;
  file: FormattedUserFile | null;
  onClose: () => void;
  onDelete?: (file: FormattedUserFile) => void;
  onSelectFile?: (file: FormattedUserFile) => void;
  onShowFileDetails?: (file: FormattedUserFile) => void;
  onFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => void;
  /**
   * Open the "Share via link" modal for this file. Wired from
   * `DriveContent` via `shareModalFileAtom`. The menu hides the
   * Share row when this is omitted, so consumers that don't want
   * the feature don't need a no-op handler.
   */
  onShareFile?: (file: FormattedUserFile) => void;
}

export default function FileContextMenu({
  x,
  y,
  file,
  onClose,
  onDelete,
  onSelectFile,
  onShowFileDetails,
  onFileDownload,
  onShareFile,
}: ContextMenuProps) {
  const [mounted, setMounted] = useState(false);
  const { polkadotAddress } = useWalletAuth();
  const { getParam } = useUrlParams();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);

  useEffect(() => {
    setMounted(true);

    // Close menu on any click outside
    const handleClickOutside = () => onClose();
    document.addEventListener("click", handleClickOutside);

    // Close menu on escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  if (!mounted || !file) return null;

  // Calculate position to ensure menu stays within viewport
  const menuStyle = {
    top: `${Math.min(y, window.innerHeight - 250)}px`,
    left: `${Math.min(x, window.innerWidth - 200)}px`
  };

  // Get file type for View option
  const { fileFormat } = getFilePartsFromFileName(file.name);
  const fileType = getFileTypeFromExtension(fileFormat || null);

  const handleShowFileDetails = () => {
    if (onShowFileDetails && file) {
      onShowFileDetails(file);
    }
    onClose();
  };

  const revealInFileManager = async () => {
    try {
      let filePath = file.source;

      // If source path is set, try it first
      if (filePath) {
        try {
          await revealItemInDir(filePath);
          onClose();
          return;
        } catch {
          // Source path failed — fall through to resolve_file_path
          console.warn("[RevealInFinder] source path failed, trying resolve_file_path. source:", filePath);
        }
      }

      // Fallback: resolve canonical path from DB
      if (file.label && polkadotAddress) {
        const fileName = file.actualFileName || file.name;
        filePath = await invoke<string>("resolve_file_path", {
          accountId: polkadotAddress,
          label: file.label,
          fileName,
        });
        await revealItemInDir(filePath);
      } else {
        toast.error("File is not available locally. It may only exist on another device.");
      }
    } catch (error) {
      console.error("Failed to reveal in file manager:", error);
      toast.error("File is not available locally. It may only exist on another device.");
    }
    onClose();
  };

  const { url: folderUrl } = generateFolderUrl(file, getParam);
  const fileManagerLabel = getFileManagerLabel();

  const menuItemClass = "flex items-center gap-2 p-2 text-xs font-medium !text-grey-30 hover:!text-grey-40 hover:bg-grey-90 border-b border-grey-80 cursor-pointer";

  return createPortal(
    <div
      className="fixed z-50"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] rounded-lg overflow-hidden p-0 min-w-[9.375rem]">
        <div className="flex flex-col">
          {file.isFolder && (
            <Link
              href={folderUrl}
              prefetch={false}
              className={menuItemClass}
            >
              <Folder className="size-4" />
              <span>Open</span>
            </Link>
          )}

          <button
            className={menuItemClass}
            onClick={() => {
              onFileDownload(file, polkadotAddress ?? "");
              onClose();
            }}
          >
            <Download className="size-4" />
            <span>Download</span>
          </button>

          {(fileType === "video" ||
            fileType === "image" ||
            fileType === "PDF") &&
            onSelectFile && (
              <button
                className={menuItemClass}
                onClick={() => {
                  onSelectFile(file);
                  onClose();
                }}
              >
                <Icons.Eye className="size-4" />
                <span>View</span>
              </button>
            )}

          <button className={menuItemClass} onClick={revealInFileManager}>
            <FolderOpen className="size-4" />
            <span>Reveal in {fileManagerLabel}</span>
          </button>

          <button className={menuItemClass} onClick={handleShowFileDetails}>
            <Icons.InfoCircle className="size-4" />
            <span>{file.isFolder ? "Folder" : "File"} Details</span>
          </button>

          {!file.isFolder && (() => {
            const cid = file.arionCid;
            return cid && cid.length > 0 ? (
              <button
                className={menuItemClass}
                onClick={async () => {
                  try {
                    await openUrl(`https://hipstats.com/file-tracker/${cid}`);
                  } catch (error) {
                    console.error("Failed to open Explorer:", error);
                  }
                  onClose();
                }}
              >
                <Icons.SendSquare2 className="size-4" />
                <span>View on Explorer</span>
              </button>
            ) : null;
          })()}

          {/*
            Share via link — appears only when:
            - the file is not a folder (folder-shares are out of scope for v1),
            - the sync engine has finished uploading it (`syncStatus === "synced"`)
              so the recipient's anonymous fetch will succeed,
            - the server advertises `shares: true` (capability gating), AND
            - a parent wired `onShareFile`.
            Folders, in-flight files, and old-server deployments all hide
            the row entirely rather than showing a disabled item — fewer
            edge cases for the user to interpret.
          */}
          {!file.isFolder
            && file.syncStatus === "synced"
            && shareEnabled
            && onShareFile && (
              <button
                className={menuItemClass}
                onClick={() => {
                  onShareFile(file);
                  onClose();
                }}
              >
                <Link2 className="size-4" />
                <span>Share via link</span>
              </button>
            )}

          <button
            className={cn("flex items-center gap-2 p-2 text-xs font-medium hover:bg-grey-90", {
              "hover:!text-error-70 !text-error-60 cursor-pointer": file.isAssigned,
              "opacity-60 cursor-not-allowed pointer-events-none !text-grey-30": !file.isAssigned
            })}
            disabled={!file.isAssigned}
            title={!file.isAssigned ? "This file is currently being synced and cannot be deleted yet. Please wait for the sync to complete." : "Delete this file"}
            onClick={() => {
              if (file.isAssigned && onDelete) {
                onDelete(file);
                onClose();
              }
            }}
          >
            <Trash2 className="size-4" />
            <span>{!file.isAssigned ? "Delete (Syncing in progress...)" : "Delete"}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
