import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Link2, Trash2, FolderOpen, Pencil } from "lucide-react";
import { Icons } from "@/components/ui";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { isPreviewableFileName } from "@/app/lib/utils/filePreviewType";
import { isCloudOnlyRow } from "@/app/lib/utils/cloudOnly";
import {
  canShareFolder,
  FOLDER_SHARE_DISABLED_TOOLTIP,
} from "@/app/lib/utils/folderShareGating";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealFile } from "@/lib/utils/revealFile";
import { useAtomValue } from "jotai";
import { toast } from "sonner";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";
import { fileManagerLabel } from "@/lib/utils/isMacPlatform";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import Link from "next/link";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { Folder } from "@/components/ui/icons";
import cn from "@/app/lib/utils/cn";
import {
  folderShareFeatureEnabledAtom,
  shareFeatureEnabledAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { canRenameFile, RENAME_DISABLED_TOOLTIP } from "@/app/lib/utils/renameGating";



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
  /**
   * Open the rename dialog for this file/folder. Wired from consumers via
   * `renameModalFileAtom`. The row is hidden when omitted (same convention
   * as `onShareFile`) and disabled — not hidden — when the entry isn't
   * renameable yet (`canRenameFile`), mirroring the Delete row's treatment
   * of mid-sync files.
   */
  onRename?: (file: FormattedUserFile) => void;
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
  onRename,
}: ContextMenuProps) {
  const [mounted, setMounted] = useState(false);
  const { polkadotAddress } = useWalletAuth();
  const { getParam } = useUrlParams();
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const folderSharesEnabled = useAtomValue(folderShareFeatureEnabledAtom);

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


  const handleShowFileDetails = () => {
    if (onShowFileDetails && file) {
      onShowFileDetails(file);
    }
    onClose();
  };

  const revealInFileManager = async () => {
    try {
      await revealFile({
        sourcePath: file.source,
        label: file.label,
        accountId: polkadotAddress ?? undefined,
        fileName: file.actualFileName || file.name,
      });
    } catch (error) {
      console.error("Failed to reveal in file manager:", error);
      toast.error(tauriErrorMessage(error));
    }
    onClose();
  };

  const { url: folderUrl } = generateFolderUrl(file, getParam);
  const fileManagerName = fileManagerLabel();

  const menuItemClass = "flex items-center gap-2 p-2 text-xs font-medium !text-grey-30 hover:!text-grey-40 hover:bg-grey-90 border-b border-grey-80 cursor-pointer dark:!text-grey-dark-200 dark:hover:!text-grey-light-100 dark:hover:bg-white/5 dark:border-black-300";

  return createPortal(
    <div
      className="fixed z-50"
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] rounded-lg overflow-hidden p-0 min-w-[9.375rem] dark:bg-black-500 dark:border-black-300 dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]">
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

          {/* Cloud-only FOLDER rows: the zip export needs a local sync root.
              Cloud-only FILE rows still download via download_remote_file. */}
          {!(isCloudOnlyRow(file) && file.isFolder) && (
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
          )}

          {!file.isFolder && isPreviewableFileName(file.name) &&
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

          {/* Nothing on disk to reveal for a cloud-only row. */}
          {!isCloudOnlyRow(file) && (
            <button className={menuItemClass} onClick={revealInFileManager}>
              <FolderOpen className="size-4" />
              <span>Reveal in {fileManagerName}</span>
            </button>
          )}

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
            Share via link — appears when the server advertises `shares: true`,
            a parent wired `onShareFile`, and either:
            - a FILE the sync engine has finished uploading (`syncStatus ===
              "synced"`), so the recipient's anonymous fetch will succeed, or
            - a FOLDER, which mints a live browsable link server-side.

            An in-flight file and an old-server deployment still hide the row
            entirely. A folder shows DISABLED with a tooltip until the server
            confirms the `folder_shares` capability (`canShareFolder`),
            matching Rename: the capability stays discoverable and the reason
            is stated, rather than the item silently differing between two
            folders that look alike.
          */}
          {(file.isFolder || file.syncStatus === "synced")
            && shareEnabled
            && onShareFile && (
              <button
                // `menuItemClass` hard-codes cursor-pointer and hover styling
                // with no disabled variant, so without this the row looks fully
                // enabled and the first click is a dead one. Mirrors the Rename
                // and Delete rows below.
                className={cn(menuItemClass, {
                  "opacity-60 cursor-not-allowed":
                    file.isFolder && !canShareFolder(file, folderSharesEnabled),
                })}
                disabled={file.isFolder && !canShareFolder(file, folderSharesEnabled)}
                title={
                  file.isFolder && !canShareFolder(file, folderSharesEnabled)
                    ? FOLDER_SHARE_DISABLED_TOOLTIP
                    : undefined
                }
                onClick={() => {
                  if (file.isFolder && !canShareFolder(file, folderSharesEnabled)) return;
                  onShareFile(file);
                  onClose();
                }}
              >
                <Link2 className="size-4" />
                <span>Share via link</span>
              </button>
            )}

          {onRename && (
            <button
              // No `pointer-events-none` here: it would stop the element
              // from ever being a hover target, making the `title` tooltip
              // unreachable. The `disabled` attribute + onClick guard
              // already block activation.
              className={cn(menuItemClass, {
                "opacity-60 cursor-not-allowed": !canRenameFile(file),
              })}
              disabled={!canRenameFile(file)}
              title={!canRenameFile(file) ? RENAME_DISABLED_TOOLTIP : undefined}
              onClick={() => {
                if (canRenameFile(file)) {
                  onRename(file);
                  onClose();
                }
              }}
            >
              <Pencil className="size-4" />
              <span>Rename</span>
            </button>
          )}

          {/* Cloud-only rows hide Delete — the pipeline removes the LOCAL
              copy and lets sync propagate, which server-only rows lack. */}
          {!isCloudOnlyRow(file) && (
            <button
              // Same rationale as the Rename row: `pointer-events-none` made
              // the disabled-state `title` tooltip unreachable.
              className={cn("flex items-center gap-2 p-2 text-xs font-medium hover:bg-grey-90 dark:hover:bg-error-70/10", {
                "hover:!text-error-70 !text-error-60 cursor-pointer dark:!text-error-70 dark:hover:!text-error-60": file.isAssigned,
                "opacity-60 cursor-not-allowed !text-grey-30 dark:!text-grey-dark-200": !file.isAssigned
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
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
