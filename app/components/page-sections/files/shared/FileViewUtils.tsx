"use client";

import { useState, useCallback } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
export interface FileViewSharedState {
  fileToDelete: FormattedUserFile | null;
  setFileToDelete: (file: FormattedUserFile | null) => void;
  openDeleteModal: boolean;
  setOpenDeleteModal: (open: boolean) => void;
  selectedFile: FormattedUserFile | null;
  setSelectedFile: (file: FormattedUserFile | null) => void;
  fileDetailsFile: FormattedUserFile | null;
  setFileDetailsFile: (file: FormattedUserFile | null) => void;
  isFileDetailsOpen: boolean;
  setIsFileDetailsOpen: (isOpen: boolean) => void;
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
  const [fileDetailsFile, setFileDetailsFile] =
    useState<FormattedUserFile | null>(null);
  const [isFileDetailsOpen, setIsFileDetailsOpen] = useState(false);
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

  const handleShowFileDetails = useCallback((file: FormattedUserFile) => {
    setFileDetailsFile(file);
    setIsFileDetailsOpen(true);
  }, []);

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
    isFileDetailsOpen,
    setIsFileDetailsOpen,
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
