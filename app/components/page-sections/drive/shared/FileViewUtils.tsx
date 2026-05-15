"use client";

import { useState, useCallback } from "react";
import { useAtom } from "jotai";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";

export interface FileViewSharedState {
  fileToDelete: FormattedUserFile | null;
  setFileToDelete: (file: FormattedUserFile | null) => void;
  openDeleteModal: boolean;
  setOpenDeleteModal: (open: boolean) => void;
  selectedFile: FormattedUserFile | null;
  setSelectedFile: (file: FormattedUserFile | null) => void;
  fileDetailsFile: FormattedUserFile | null;
  setFileDetailsFile: (file: FormattedUserFile | null) => void;
  deleteFile: () => Promise<void>;
  isDeleting: boolean;
  handleDelete: () => void;

  handleShowFileDetails: (file: FormattedUserFile) => void;
  getFileType: (file: FormattedUserFile) => string | null;
  contextMenu: { x: number; y: number; file: FormattedUserFile } | null;
  setContextMenu: (
    menu: { x: number; y: number; file: FormattedUserFile } | null
  ) => void;
  handleContextMenu: (e: React.MouseEvent, file: FormattedUserFile) => void;
}

export function useFileViewShared(): FileViewSharedState {

  const [fileToDelete, setFileToDelete] =
    useState<FormattedUserFile | null>(null);
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const { mutateAsync: deleteFileMutation, isPending: isDeleting } =
    useDeleteFile({
      files: fileToDelete ? [fileToDelete] : [],
    });

  const [selectedFile, setSelectedFile] =
    useState<FormattedUserFile | null>(null);
  // File-details state lives in a global atom so the inline FileDetailsPanel
  // mounted on the page (sibling of <Drive />) can read it. Every consumer —
  // table rows, card view, context menus — flips this single source of truth.
  const [fileDetailsFile, setFileDetailsFile] = useAtom(fileDetailsPanelAtom);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FormattedUserFile;
  } | null>(null);

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
    (e: React.MouseEvent, file: FormattedUserFile) => {
      e.preventDefault();
      e.stopPropagation();
      // Clear any text selection caused by right-click
      window.getSelection()?.removeAllRanges();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        file: file,
      });
    },
    []
  );

  return {
    fileToDelete,
    setFileToDelete,
    openDeleteModal,
    setOpenDeleteModal,
    selectedFile,
    setSelectedFile,
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
