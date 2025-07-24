"use client";

import { useState, useCallback } from "react";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { useDeleteIpfsFile } from "@/lib/hooks";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { decodeHexCid } from "@/app/lib/utils/decodeHexCid";
import { FileDetail } from "../files-table/UnpinFilesDialog";

export interface FileViewSharedProps {
  files: FormattedUserIpfsFile[];
  showUnpinnedDialog: boolean;
  isRecentFiles: boolean;
  resetPagination: boolean;
  onPaginationReset: () => void;
}

export interface FileViewSharedState {
  fileToDelete: FormattedUserIpfsFile | null;
  setFileToDelete: (file: FormattedUserIpfsFile | null) => void;
  openDeleteModal: boolean;
  setOpenDeleteModal: (open: boolean) => void;
  selectedFile: FormattedUserIpfsFile | null;
  setSelectedFile: (file: FormattedUserIpfsFile | null) => void;
  unpinnedFiles: FileDetail[] | null;
  isUnpinnedOpen: boolean;
  fileDetailsFile: FormattedUserIpfsFile | null;
  setFileDetailsFile: (file: FormattedUserIpfsFile | null) => void;
  isFileDetailsOpen: boolean;
  setIsFileDetailsOpen: (isOpen: boolean) => void;
  deleteFile: () => Promise<void>;
  isDeleting: boolean;
  handleDelete: () => void;

  handleCopyLink: (file: FormattedUserIpfsFile) => void;
  handleOpenInExplorer: (file: FormattedUserIpfsFile) => Promise<void>;
  handleOpenOnIpfs: (file: FormattedUserIpfsFile) => Promise<void>;
  handleShowFileDetails: (file: FormattedUserIpfsFile) => void;
  getFileType: (file: FormattedUserIpfsFile) => string | null;
  contextMenu: { x: number; y: number; file: FormattedUserIpfsFile } | null;
  setContextMenu: (
    menu: { x: number; y: number; file: FormattedUserIpfsFile } | null
  ) => void;
  handleContextMenu: (e: React.MouseEvent, file: FormattedUserIpfsFile) => void;
}

export function useFileViewShared(
  props: FileViewSharedProps
): FileViewSharedState {
  const { files, showUnpinnedDialog } = props;

  const [fileToDelete, setFileToDelete] =
    useState<FormattedUserIpfsFile | null>(null);
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const { mutateAsync: deleteFileMutation, isPending: isDeleting } =
    useDeleteIpfsFile({
      cid: fileToDelete?.cid || "",
      fileToDelete
    });

  const [selectedFile, setSelectedFile] =
    useState<FormattedUserIpfsFile | null>(null);
  const [unpinnedFiles, setUnpinnedFiles] = useState<FileDetail[] | null>(null);
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);
  const [fileDetailsFile, setFileDetailsFile] =
    useState<FormattedUserIpfsFile | null>(null);
  const [isFileDetailsOpen, setIsFileDetailsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FormattedUserIpfsFile;
  } | null>(null);

  // Extract unpinned file details from files
  const unpinnedFileDetails = showUnpinnedDialog
    ? files
        .filter((file) => !file.isAssigned)
        .map((file) => ({
          filename: file.name || "Unnamed File",
          cid: decodeHexCid(file.cid),
          createdAt: file.createdAt
        }))
    : [];

  // Update unpinned files state when unpinned file details change
  if (showUnpinnedDialog && unpinnedFileDetails.length > 0 && !unpinnedFiles) {
    setUnpinnedFiles(unpinnedFileDetails);
    setIsUnpinnedOpen(true);
  } else if (
    (showUnpinnedDialog && unpinnedFileDetails.length === 0 && unpinnedFiles) ||
    !showUnpinnedDialog
  ) {
    if (unpinnedFiles !== null) {
      setUnpinnedFiles(null);
      setIsUnpinnedOpen(false);
    }
  }

  const deleteFile = async () => {
    await deleteFileMutation();
  };

  const handleDelete = () => {
    setOpenDeleteModal(true);
  };

  const handleCopyLink = useCallback((file: FormattedUserIpfsFile) => {
    navigator.clipboard
      .writeText(`https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`)
      .then(() => {
        toast.success("Copied to clipboard successfully!");
      });
  }, []);

  const handleOpenInExplorer = useCallback(
    async (file: FormattedUserIpfsFile) => {
      try {
        await openUrl(
          `http://hipstats.com/cid-tracker/${decodeHexCid(file.cid)}`
        );
      } catch (error) {
        console.error("Failed to open Explorer:", error);
      }
    },
    []
  );

  const handleOpenOnIpfs = useCallback(async (file: FormattedUserIpfsFile) => {
    try {
      await openUrl(
        `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`
      );
    } catch (error) {
      console.error("Failed to open on IPFS:", error);
    }
  }, []);

  const handleShowFileDetails = useCallback((file: FormattedUserIpfsFile) => {
    setFileDetailsFile(file);
    setIsFileDetailsOpen(true);
  }, []);

  const getFileType = useCallback(
    (file: FormattedUserIpfsFile): string | null => {
      const { fileFormat } = getFilePartsFromFileName(file.name);
      return getFileTypeFromExtension(fileFormat || null);
    },
    []
  );

  // Handle context menu events (right-click)
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, file: FormattedUserIpfsFile) => {
      e.preventDefault();
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        file: file
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
    unpinnedFiles,
    isUnpinnedOpen,
    fileDetailsFile,
    setFileDetailsFile,
    isFileDetailsOpen,
    setIsFileDetailsOpen,
    deleteFile,
    isDeleting,
    handleDelete,
    handleCopyLink,
    handleOpenInExplorer,
    handleOpenOnIpfs,
    handleShowFileDetails,
    getFileType,
    contextMenu,
    setContextMenu,
    handleContextMenu
  };
}
