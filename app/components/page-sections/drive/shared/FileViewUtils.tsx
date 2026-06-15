"use client";

import { useState, useCallback } from "react";
import { useAtom } from "jotai";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import {
  EMPTY_VIEWER_SELECTION,
  nextViewerSelection,
} from "./viewerSelection";

export interface FileViewContextMenu {
  x: number;
  y: number;
  file: FormattedUserFile;
  /** Sibling rows of the right-clicked file when it came from an
   *  inline-expanded folder — forwarded into the viewer on "View" so the
   *  thumbnail rail shows that folder, not the page's top-level list. */
  previewList?: FormattedUserFile[] | null;
}

export interface FileViewSharedState {
  fileToDelete: FormattedUserFile | null;
  setFileToDelete: (file: FormattedUserFile | null) => void;
  openDeleteModal: boolean;
  setOpenDeleteModal: (open: boolean) => void;
  selectedFile: FormattedUserFile | null;
  /** Opens `file` in the media viewer. `previewList` is the sibling list
   *  the file was opened from (an inline-expanded folder's rows); the
   *  viewer's thumbnail rail and prev/next walk it instead of the page's
   *  top-level list. Omit it for top-level rows (page-list fallback). */
  setSelectedFile: (
    file: FormattedUserFile | null,
    previewList?: FormattedUserFile[] | null,
  ) => void;
  /** The sibling list paired with `selectedFile`, or null when the viewer
   *  should fall back to the page's own file list. */
  previewList: FormattedUserFile[] | null;
  fileDetailsFile: FormattedUserFile | null;
  setFileDetailsFile: (file: FormattedUserFile | null) => void;
  deleteFile: () => Promise<void>;
  isDeleting: boolean;
  handleDelete: () => void;

  handleShowFileDetails: (file: FormattedUserFile) => void;
  getFileType: (file: FormattedUserFile) => string | null;
  contextMenu: FileViewContextMenu | null;
  setContextMenu: (menu: FileViewContextMenu | null) => void;
  handleContextMenu: (
    e: React.MouseEvent,
    file: FormattedUserFile,
    previewList?: FormattedUserFile[] | null,
  ) => void;
}

export function useFileViewShared(): FileViewSharedState {

  const [fileToDelete, setFileToDelete] =
    useState<FormattedUserFile | null>(null);
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const { mutateAsync: deleteFileMutation, isPending: isDeleting } =
    useDeleteFile({
      files: fileToDelete ? [fileToDelete] : [],
    });

  // Selected file + its preview list are one state value (see
  // viewerSelection.ts) so a viewer open can never pair a nested file with
  // the wrong sibling list.
  const [viewerSelection, setViewerSelection] = useState(
    EMPTY_VIEWER_SELECTION,
  );
  const setSelectedFile = useCallback(
    (
      file: FormattedUserFile | null,
      previewList: FormattedUserFile[] | null = null,
    ) => {
      setViewerSelection(nextViewerSelection(file, previewList));
    },
    [],
  );
  // File-details state lives in a global atom so the inline FileDetailsPanel
  // mounted on the page (sibling of <Drive />) can read it. Every consumer —
  // table rows, card view, context menus — flips this single source of truth.
  const [fileDetailsFile, setFileDetailsFile] = useAtom(fileDetailsPanelAtom);
  const [contextMenu, setContextMenu] = useState<FileViewContextMenu | null>(
    null,
  );

  const deleteFile = async () => {
    await deleteFileMutation();
  };

  const handleDelete = () => {
    setOpenDeleteModal(true);
  };

  const handleShowFileDetails = useCallback(
    (file: FormattedUserFile) => {
      setFileDetailsFile(file);
    },
    [setFileDetailsFile],
  );

  const getFileType = useCallback(
    (file: FormattedUserFile): string | null => {
      const { fileFormat } = getFilePartsFromFileName(file.name);
      return getFileTypeFromExtension(fileFormat || null);
    },
    []
  );

  // Handle context menu events (right-click)
  const handleContextMenu = useCallback(
    (
      e: React.MouseEvent,
      file: FormattedUserFile,
      previewList: FormattedUserFile[] | null = null,
    ) => {
      e.preventDefault();
      e.stopPropagation();
      // Clear any text selection caused by right-click
      window.getSelection()?.removeAllRanges();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        file: file,
        previewList,
      });
    },
    []
  );

  return {
    fileToDelete,
    setFileToDelete,
    openDeleteModal,
    setOpenDeleteModal,
    selectedFile: viewerSelection.file,
    setSelectedFile,
    previewList: viewerSelection.previewList,
    fileDetailsFile,
    setFileDetailsFile,
    deleteFile,
    isDeleting,
    handleDelete,
    handleShowFileDetails,
    getFileType,
    contextMenu,
    setContextMenu,
    handleContextMenu,
  };
}
