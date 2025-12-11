"use client";

import { useState, useCallback } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { decodeHexCid } from "@/app/lib/utils/decodeHexCid";
import { FileDetail } from "@/app/(pages)/UnpinFilesDialog";
import { useAtom } from "jotai";
import { activeSubMenuItemAtom } from "@/app/components/sidebar/sideBarAtoms";

export interface FileViewSharedProps {
  files: FormattedUserFile[];
  showUnpinnedDialog: boolean;
  isRecentFiles: boolean;
  resetPagination: boolean;
  onPaginationReset: () => void;
}

export interface FileViewSharedState {
  fileToDelete: FormattedUserFile | null;
  setFileToDelete: (file: FormattedUserFile | null) => void;
  openDeleteModal: boolean;
  setOpenDeleteModal: (open: boolean) => void;
  selectedFile: FormattedUserFile | null;
  setSelectedFile: (file: FormattedUserFile | null) => void;
  unpinnedFiles: FileDetail[] | null;
  isUnpinnedOpen: boolean;
  fileDetailsFile: FormattedUserFile | null;
  setFileDetailsFile: (file: FormattedUserFile | null) => void;
  isFileDetailsOpen: boolean;
  setIsFileDetailsOpen: (isOpen: boolean) => void;
  deleteFile: () => Promise<void>;
  isDeleting: boolean;
  handleDelete: () => void;

  handleCopyLink: (file: FormattedUserFile) => void;
  handleOpenInExplorer: (file: FormattedUserFile) => Promise<void>;
  handleOpenOnIpfs: (file: FormattedUserFile) => Promise<void>;
  handleShowFileDetails: (file: FormattedUserFile) => void;
  getFileType: (file: FormattedUserFile) => string | null;
  contextMenu: { x: number; y: number; file: FormattedUserFile } | null;
  setContextMenu: (
    menu: { x: number; y: number; file: FormattedUserFile } | null
  ) => void;
  handleContextMenu: (e: React.MouseEvent, file: FormattedUserFile) => void;
}

export function useFileViewShared(
  props: FileViewSharedProps
): FileViewSharedState {
  const { files, showUnpinnedDialog } = props;
  // Ensure files is always an array to prevent undefined errors
  const safeFiles = files || [];
  const [activeSubMenuItem] = useAtom(activeSubMenuItemAtom);

  const isPrivateFolder = activeSubMenuItem === "Private";

  const [fileToDelete, setFileToDelete] =
    useState<FormattedUserFile | null>(null);
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const { mutateAsync: deleteFileMutation, isPending: isDeleting } =
    useDeleteFile({
      files: fileToDelete ? [fileToDelete] : [],
      isPrivateFolder,
    });

  const [selectedFile, setSelectedFile] =
    useState<FormattedUserFile | null>(null);
  const [unpinnedFiles, setUnpinnedFiles] = useState<FileDetail[] | null>(null);
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);
  const [fileDetailsFile, setFileDetailsFile] =
    useState<FormattedUserFile | null>(null);
  const [isFileDetailsOpen, setIsFileDetailsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FormattedUserFile;
  } | null>(null);

  // Extract unpinned file details from files
  const unpinnedFileDetails = showUnpinnedDialog
    ? safeFiles
      .filter((file) => !file.isAssigned)
      .map((file) => ({
        filename: file.name || "Unnamed File",
        cid: decodeHexCid(file.cid),
        createdAt: file.createdAt,
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
    console.log("we are here in delete File");
    await deleteFileMutation();
  };

  const handleDelete = () => {
    setOpenDeleteModal(true);
  };

  const handleCopyLink = useCallback((file: FormattedUserFile) => {
    navigator.clipboard
      .writeText(`https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`)
      .then(() => {
        toast.success("Copied to clipboard successfully!");
      });
  }, []);

  const handleOpenInExplorer = useCallback(
    async (file: FormattedUserFile) => {
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

  const handleOpenOnIpfs = useCallback(async (file: FormattedUserFile) => {
    try {
      await openUrl(
        `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`
      );
    } catch (error) {
      console.error("Failed to open on IPFS:", error);
    }
  }, []);

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
    handleContextMenu,
  };
}
