"use client";

import React from "react";

import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { FileViewerLayout } from "@/app/components/page-sections/drive/file-viewer";

import UnifiedFilePreview from "./UnifiedFilePreview";

/**
 * The one dialog entry point for every previewable file.
 *
 * Call sites choose a **file and the sibling list it was opened from** and
 * nothing else — they no longer decide which dialog implementation to mount.
 * That decision used to be duplicated at every entry point as a
 * `selectedFileType === "video" | "image" | "PDF"` ladder (the drive page, the
 * sidebar search, the card menu, the context menu), which is why adding a
 * format meant touching all of them and any one could be missed.
 *
 * This owns the chrome — `FileViewerLayout`'s title, share/download/delete
 * actions, prev/next, thumbnail rail and close — while `UnifiedFilePreview`
 * owns the content. Rendering nothing for a null file keeps the caller's
 * "open the viewer" state a single nullable value.
 */
export default function UnifiedMediaDialog({
  file,
  allFiles,
  onCloseClicked,
  onNavigate,
  handleFileDownload,
  onDelete,
}: {
  /** The open file, or `null` when the viewer is closed. */
  file: FormattedUserFile | null;
  /**
   * The sibling list `file` was opened from — an inline-expanded folder's
   * rows, a search result list, or the page's own list. The thumbnail rail
   * and prev/next walk exactly this, which is what keeps a nested file scoped
   * to its own folder.
   */
  allFiles: FormattedUserFile[];
  onCloseClicked: () => void;
  onNavigate: (file: FormattedUserFile) => void;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
  /**
   * Direct delete handler. When provided (the sidebar search preview, which
   * has no drive-page selection bar) the trash button calls this; the drive
   * page omits it and keeps the selection-mode → action-bar flow.
   */
  onDelete?: (file: FormattedUserFile) => void;
}) {
  if (!file) return null;

  return (
    <FileViewerLayout
      file={file}
      allFiles={allFiles}
      onClose={onCloseClicked}
      onNavigate={onNavigate}
      handleFileDownload={handleFileDownload}
      onDelete={onDelete}
    >
      {/* Keyed on file identity so every renderer body remounts on navigation:
          no renderer can carry state, DOM or an in-flight read across files. */}
      <UnifiedFilePreview
        key={`${file.label ?? ""}::${file.actualFileName || file.name}`}
        file={file}
        handleFileDownload={handleFileDownload}
      />
    </FileViewerLayout>
  );
}
