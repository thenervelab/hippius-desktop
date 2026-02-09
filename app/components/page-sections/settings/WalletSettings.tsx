"use client";

import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Icons,
  RevealTextLine,
  CardButton,
  Input,
  AbstractIconWrapper,
} from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { InView } from "react-intersection-observer";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { LocalWallet } from "@/app/lib/helpers/localWalletDb";
import { cn } from "@/lib/utils";
import { AddWalletDialog } from "@/app/components/page-sections/wallet/local-wallet";
import DeleteConfirmationDialog from "@/components/DeleteConfirmationDialog";
import DialogContainer from "@/components/ui/DialogContainer";
import BoxSimple from "@/components/ui/icons/BoxSimple";
import {
  Edit2,
  Download,
  X,
  AlertTriangle,
} from "lucide-react";
import {
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { getWalletColumns } from "./WalletColumns";

// Column widths for the wallet table (defined outside component to avoid recreating)
const DEFAULT_COLUMN_WIDTHS = {
  wallet: 35,
  date_imported: 25,
  status: 25,
  actions: 15,
};

const MIN_COLUMN_WIDTHS = {
  wallet: 20,
  date_imported: 15,
  status: 15,
  actions: 10,
};

const WalletSettings: React.FC = () => {
  const {
    wallets,
    switchWallet,
    renameWallet,
    removeWallet,
    importEncryptedWallet,
    truncateAddress,
  } = useLocalWallet();

  // Dialog states
  const [showAddWalletDialog, setShowAddWalletDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [walletToDelete, setWalletToDelete] = useState<LocalWallet | null>(
    null
  );
  const [isDeleting, setIsDeleting] = useState(false);

  // Export states
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [walletToExport, setWalletToExport] = useState<LocalWallet | null>(
    null
  );
  const [isExporting, setIsExporting] = useState(false);

  // Edit dialog states
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [walletToEdit, setWalletToEdit] = useState<LocalWallet | null>(null);
  const [editingName, setEditingName] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Import file state
  const [importedFile, setImportedFile] = useState<{
    name: string;
    address: string;
    encryptedMnemonic: string;
    passcodeHash: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [importError, setImportError] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [columnWidths, setColumnWidths] = useState(() => {
    try {
      const stored = localStorage.getItem('walletSettingsTable_columnWidths');
      return stored ? JSON.parse(stored) : DEFAULT_COLUMN_WIDTHS;
    } catch {
      return DEFAULT_COLUMN_WIDTHS;
    }
  });

  const [isResizing, setIsResizing] = useState(false);
  const [resizeData, setResizeData] = useState<{
    columnId: string;
    startX: number;
    startWidth: number;
    nextColumnId: string;
    nextStartWidth: number;
  } | null>(null);
  const [justResized, setJustResized] = useState(false);

  // Save column widths to localStorage
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      try {
        localStorage.setItem('walletSettingsTable_columnWidths', JSON.stringify(columnWidths));
      } catch { }
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [columnWidths]);

  const handleResizeStart = useCallback((columnId: string, startX: number) => {
    const columnIds = Object.keys(columnWidths);
    const currentIndex = columnIds.indexOf(columnId);
    const nextColumnId = columnIds[currentIndex + 1];

    if (nextColumnId && columnId !== 'actions') {
      setIsResizing(true);
      setResizeData({
        columnId,
        startX,
        startWidth: columnWidths[columnId],
        nextColumnId,
        nextStartWidth: columnWidths[nextColumnId],
      });
    }
  }, [columnWidths]);

  const handleResizeMove = useCallback((clientX: number) => {
    if (!resizeData || !isResizing) return;

    requestAnimationFrame(() => {
      const diff = clientX - resizeData.startX;
      const standardTableWidth = 1200;
      const sensitivity = 2.2;
      const diffPercent = (diff / standardTableWidth) * 100 * sensitivity;

      const proposedCurrentWidth = resizeData.startWidth + diffPercent;
      const proposedNextWidth = resizeData.nextStartWidth - diffPercent;

      const currentMinWidth = MIN_COLUMN_WIDTHS[resizeData.columnId as keyof typeof MIN_COLUMN_WIDTHS] || 8;
      const nextMinWidth = MIN_COLUMN_WIDTHS[resizeData.nextColumnId as keyof typeof MIN_COLUMN_WIDTHS] || 8;

      let newCurrentWidth = proposedCurrentWidth;
      let newNextWidth = proposedNextWidth;

      if (proposedCurrentWidth < currentMinWidth) {
        newCurrentWidth = currentMinWidth;
        newNextWidth = resizeData.startWidth + resizeData.nextStartWidth - currentMinWidth;
      } else if (proposedNextWidth < nextMinWidth) {
        newNextWidth = nextMinWidth;
        newCurrentWidth = resizeData.startWidth + resizeData.nextStartWidth - nextMinWidth;
      }

      newCurrentWidth = Math.min(80, newCurrentWidth);
      newNextWidth = Math.min(80, newNextWidth);

      if (newCurrentWidth >= currentMinWidth && newNextWidth >= nextMinWidth) {
        setColumnWidths((prev: Record<string, number>) => ({
          ...prev,
          [resizeData.columnId]: newCurrentWidth,
          [resizeData.nextColumnId]: newNextWidth,
        }));
      }
    });
  }, [resizeData, isResizing]);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    setResizeData(null);
    setJustResized(true);
    setTimeout(() => {
      setJustResized(false);
    }, 100);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => handleResizeMove(e.clientX);
    const handleMouseUp = () => handleResizeEnd();

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  // Handle make active wallet
  const handleMakeActive = useCallback(async (walletId: number) => {
    const success = await switchWallet(walletId);
    if (success) {
      toast.success("Wallet set as active");
    } else {
      toast.error("Failed to switch wallet");
    }
  }, [switchWallet]);

  // Handle edit wallet name via dialog
  const handleEditClick = useCallback((wallet: LocalWallet) => {
    setWalletToEdit(wallet);
    setEditingName(wallet.name);
    setShowEditDialog(true);
  }, []);

  const handleSaveEdit = async () => {
    if (!walletToEdit || !editingName.trim()) return;

    setIsSavingEdit(true);
    try {
      const success = await renameWallet(walletToEdit.id, editingName.trim());
      if (success) {
        toast.success("Wallet renamed successfully");
        setShowEditDialog(false);
        setWalletToEdit(null);
        setEditingName("");
      } else {
        toast.error("Failed to rename wallet");
      }
    } finally {
      setIsSavingEdit(false);
    }
  };

  // Handle export wallet (no passcode needed - exports encrypted data)
  const handleExportClick = useCallback((wallet: LocalWallet) => {
    setWalletToExport(wallet);
    setShowExportDialog(true);
  }, []);

  const handleExportWallet = async () => {
    if (!walletToExport) return;

    setIsExporting(true);

    try {
      // Export the encrypted wallet data directly (no decryption needed)
      const backupData = {
        version: 2, // Version 2 = encrypted backup format
        name: walletToExport.name,
        address: walletToExport.address,
        encryptedMnemonic: walletToExport.encryptedMnemonic,
        passcodeHash: walletToExport.passcodeHash,
        exportedAt: new Date().toISOString(),
      };

      // Create and download the file
      const blob = new Blob([JSON.stringify(backupData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hippius-wallet-${walletToExport.name.replace(/\s+/g, "-")}-backup.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("Wallet backup downloaded successfully");
      setShowExportDialog(false);
      setWalletToExport(null);
    } catch (error) {
      console.error("Export failed:", error);
      toast.error("Failed to export wallet");
    } finally {
      setIsExporting(false);
    }
  };

  // Handle delete wallet
  const handleDeleteClick = useCallback((wallet: LocalWallet) => {
    setWalletToDelete(wallet);
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = async () => {
    if (!walletToDelete) return;

    setIsDeleting(true);
    try {
      const success = await removeWallet(walletToDelete.id);
      if (success) {
        toast.success("Wallet deleted successfully");
      } else {
        toast.error("Failed to delete wallet");
      }
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
      setWalletToDelete(null);
    }
  };

  // Import file handling
  const processFile = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Check for version 2 format (encrypted backup)
      if (data.version === 2 && data.encryptedMnemonic && data.passcodeHash && data.address) {
        setImportedFile({
          name: data.name || "Imported Wallet",
          address: data.address,
          encryptedMnemonic: data.encryptedMnemonic,
          passcodeHash: data.passcodeHash,
        });
        setImportError("");
      } else if (data.encryptedMnemonic && data.passcodeHash) {
        // Older format with encrypted mnemonic but might not have address
        // This shouldn't happen with our exports, but handle gracefully
        setImportError(
          "This backup file format is not supported. Please export a new backup."
        );
      } else if (data.mnemonic) {
        // Version 1 format with plain mnemonic - not supported in this import flow
        setImportError(
          "This backup contains an unencrypted mnemonic. Please use 'Add Wallet' and enter the mnemonic manually."
        );
      } else {
        setImportError("Invalid wallet backup file");
      }
    } catch {
      setImportError("Failed to read wallet backup file");
    }
  };

  const handleFileDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const droppedFile = e.dataTransfer.files[0];
        await processFile(droppedFile);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    []
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        await processFile(file);
      }
    },
    []
  );

  const clearImportFile = () => {
    setImportedFile(null);
    setImportError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImportWallet = async () => {
    if (!importedFile) return;

    setIsImporting(true);
    setImportError("");

    try {
      const success = await importEncryptedWallet({
        name: importedFile.name,
        address: importedFile.address,
        encryptedMnemonic: importedFile.encryptedMnemonic,
        passcodeHash: importedFile.passcodeHash,
      });

      if (success) {
        toast.success("Wallet imported successfully!");
        setShowImportDialog(false);
        setImportedFile(null);
      } else {
        setImportError(
          "Failed to import wallet. This wallet may already exist."
        );
      }
    } catch (error) {
      console.error("Failed to import wallet:", error);
      setImportError(
        error instanceof Error ? error.message : "Failed to import wallet"
      );
    } finally {
      setIsImporting(false);
    }
  };

  const closeImportDialog = () => {
    setShowImportDialog(false);
    setImportedFile(null);
    setImportError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Copy address to clipboard
  const handleCopyAddress = useCallback((address: string) => {
    navigator.clipboard.writeText(address);
    toast.success("Address copied to clipboard");
  }, []);

  // Memoized columns
  const columns = useMemo(() => getWalletColumns({
    truncateAddress,
    onCopyAddress: handleCopyAddress,
    onMakeActive: handleMakeActive,
    onEdit: handleEditClick,
    onExport: handleExportClick,
    onDelete: handleDeleteClick,
  }), [truncateAddress, handleCopyAddress, handleMakeActive, handleEditClick, handleExportClick, handleDeleteClick]);

  // Table instance
  const table = useReactTable({
    columns,
    data: wallets || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableColumnResizing: true,
  });

  // Memoized header rows (same pattern as files table)
  const headerRows = useMemo(
    () =>
      table.getHeaderGroups().map((headerGroup) => (
        <TableModule.Tr key={headerGroup.id} draggable={false}>
          {headerGroup.headers.map((header) => (
            <TableModule.Th
              key={header.id}
              header={header}
              align="left"
              columnWidth={columnWidths[header.id]}
              onResizeStart={handleResizeStart}
              preventSort={justResized}
            />
          ))}
        </TableModule.Tr>
      )),
    [table, columnWidths, handleResizeStart, justResized]
  );

  // Memoized table body (same pattern as files table)
  const tableBody = useMemo(
    () =>
      table.getRowModel().rows.map((row) => (
        <TableModule.Tr
          rowHover
          key={row.id}
        >
          {row.getVisibleCells().map((cell) => (
            <TableModule.Td
              key={cell.id}
              cell={cell}
              columnWidth={columnWidths[cell.column.id]}
            />
          ))}
        </TableModule.Tr>
      )),
    [table, columnWidths]
  );

  return (
    <>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover"
          >
            <div className="w-full flex flex-col">
              <div className="w-full">
                <RevealTextLine
                  rotate
                  reveal={inView}
                  parentClassName="w-full"
                  className="delay-300 w-full"
                >
                  <div className="w-full flex justify-between gap-4 items-start">
                    <SectionHeader
                      Icon={Icons.Wallet}
                      title="Wallet Settings"
                      subtitle="Manage your local wallets, import new wallets, or export backups."
                      info="Your wallets are stored locally with encrypted mnemonics. You can add multiple wallets and switch between them. Export your wallet to create an encrypted backup file that can be imported later."
                      learnMoreUrl="https://docs.hippius.com/use/desktop/settings#wallet-settings"
                    />
                    <div className="flex gap-2">
                      <CardButton
                        variant="secondary"
                        className="h-10 px-4"
                        onClick={() => setShowAddWalletDialog(true)}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Icons.WalletAdd className="size-4" />
                          Add Wallet
                        </div>
                      </CardButton>
                      <CardButton
                        variant="dialog"
                        className="h-10 px-4"
                        onClick={() => setShowImportDialog(true)}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Icons.DocumentDownload className="size-4" />
                          Import New Wallet
                        </div>
                      </CardButton>
                    </div>
                  </div>
                </RevealTextLine>
              </div>

              {/* Wallets Table */}
              <div className="w-full mt-6">
                {!wallets || wallets.length === 0 ? (
                  <div className="w-full overflow-hidden border border-grey-80 rounded-lg bg-white px-6 py-12 text-center text-grey-60">
                    No wallets found. Add a wallet to get started.
                  </div>
                ) : (
                  <TableModule.TableWrapper>
                    <TableModule.Table className="w-full table-fixed">
                      <TableModule.THead>{headerRows}</TableModule.THead>
                      <TableModule.TBody>{tableBody}</TableModule.TBody>
                    </TableModule.Table>
                  </TableModule.TableWrapper>
                )}
              </div>
            </div>
          </div>
        )}
      </InView>

      {/* Add Wallet Dialog */}
      <AddWalletDialog
        open={showAddWalletDialog}
        onClose={() => setShowAddWalletDialog(false)}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onClose={() => {
          setShowDeleteDialog(false);
          setWalletToDelete(null);
        }}
        onDelete={handleConfirmDelete}
        onBack={() => {
          setShowDeleteDialog(false);
          setWalletToDelete(null);
        }}
        heading="Delete Wallet"
        text={`Are you sure you want to delete "${walletToDelete?.name}"? This action cannot be undone. Make sure you have a backup of your wallet before deleting.`}
        button={isDeleting ? "Deleting..." : "Delete Wallet"}
        disableButton={isDeleting}
      />

      {/* Edit Wallet Dialog */}
      <Dialog.Root
        open={showEditDialog}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setShowEditDialog(false);
            setWalletToEdit(null);
            setEditingName("");
          }
        }}
      >
        <DialogContainer className="md:inset-0 md:m-auto w-[400px] h-fit">
          <Dialog.Title className="sr-only">Edit Wallet Name</Dialog.Title>

          <div className="flex flex-col items-center px-6 py-8">
            <div className="h-12 w-12 bg-primary-50/10 rounded-lg flex items-center justify-center mb-4">
              <Edit2 className="size-6 text-primary-50" />
            </div>

            <h2 className="text-xl font-semibold text-grey-10 mb-2">
              Edit Wallet Name
            </h2>
            <p className="text-sm text-grey-60 text-center mb-6">
              Change the display name for &quot;{walletToEdit?.name}&quot;
            </p>

            <div className="w-full mb-6">
              <label className="block text-sm font-medium text-grey-60 mb-2">
                Wallet Name
              </label>
              <Input
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                placeholder="Enter wallet name"
                className="w-full"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !isSavingEdit) handleSaveEdit();
                }}
              />
            </div>

            <div className="flex gap-3 w-full">
              <CardButton
                variant="secondary"
                className="flex-1 h-10"
                onClick={() => {
                  setShowEditDialog(false);
                  setWalletToEdit(null);
                  setEditingName("");
                }}
                disabled={isSavingEdit}
              >
                Cancel
              </CardButton>
              <CardButton
                variant="dialog"
                className="flex-1 h-10"
                onClick={handleSaveEdit}
                disabled={!editingName.trim() || isSavingEdit}
              >
                {isSavingEdit ? "Saving..." : "Save Changes"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>

      {/* Export Wallet Dialog */}
      <Dialog.Root
        open={showExportDialog}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setShowExportDialog(false);
            setWalletToExport(null);
          }
        }}
      >
        <DialogContainer className="md:inset-0 md:m-auto w-[450px] h-fit">
          <Dialog.Title className="sr-only">Export Wallet</Dialog.Title>

          <div className="flex flex-col items-center px-6 py-8">
            <div className="h-12 w-12 bg-primary-50/10 rounded-lg flex items-center justify-center mb-4">
              <Download className="size-6 text-primary-50" />
            </div>

            <h2 className="text-xl font-semibold text-grey-10 mb-2">
              Export Wallet
            </h2>
            <p className="text-sm text-grey-60 text-center mb-6">
              Export &quot;{walletToExport?.name}&quot; as an encrypted backup file
            </p>

            {/* Combined info box */}
            <div className="w-full bg-warning-50/10 border border-warning-50/20 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="size-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-grey-40">
                  <p className="mb-2">
                    Your wallet will be exported in encrypted form. You&apos;ll need
                    your passcode when signing transactions after importing.
                  </p>
                  <p className="text-amber-600">
                    <strong className="text-amber-700">Warning:</strong> Keep this backup file
                    secure. Anyone with this file and your passcode can access
                    your wallet.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-3 w-full">
              <CardButton
                variant="secondary"
                className="flex-1 h-10"
                onClick={() => {
                  setShowExportDialog(false);
                  setWalletToExport(null);
                }}
                disabled={isExporting}
              >
                Cancel
              </CardButton>
              <CardButton
                variant="dialog"
                className="flex-1 h-10"
                onClick={handleExportWallet}
                disabled={isExporting}
              >
                {isExporting ? "Exporting..." : "Download Backup"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>

      {/* Import Wallet Dialog */}
      <Dialog.Root
        open={showImportDialog}
        onOpenChange={(isOpen) => {
          if (!isOpen) closeImportDialog();
        }}
      >
        <DialogContainer className="md:inset-0 md:m-auto w-[450px] h-fit">
          <Dialog.Title className="sr-only">Import Wallet</Dialog.Title>

          <div className="flex flex-col items-center px-6 py-8">
            <div className="h-12 w-12 bg-primary-50/10 rounded-lg flex items-center justify-center mb-4">
              <Icons.DocumentDownload className="size-6 text-primary-50" />
            </div>

            <h2 className="text-xl font-semibold text-grey-10 mb-2">
              Import Wallet Backup
            </h2>
            <p className="text-sm text-grey-60 text-center mb-6">
              Import an encrypted wallet backup file
            </p>

            {/* File Drop Zone */}
            {!importedFile ? (
              <div
                className={cn(
                  "w-full rounded-lg h-[140px] p-2 transition mb-4",
                  isDragging
                    ? "bg-primary-50/5 border-2 border-dashed border-primary-50"
                    : "border border-grey-80"
                )}
              >
                <div
                  className="cursor-pointer border border-grey-80 rounded-xl border-dashed flex flex-col items-center justify-center h-full w-full transition hover:bg-grey-98"
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleFileDrop}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                  }}
                >
                  <div className="mb-2">
                    <AbstractIconWrapper className="size-8">
                      <BoxSimple className="size-5 text-primary-50 absolute" />
                    </AbstractIconWrapper>
                  </div>
                  <div className="text-sm font-medium text-grey-10">
                    Upload Backup File
                  </div>
                  <div className="text-grey-60 text-xs">
                    Drag & drop or click to select
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                </div>
              </div>
            ) : (
              <div className="w-full mb-4 p-4 bg-grey-98 border border-grey-80 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Icons.File className="size-5 text-primary-50" />
                    <div>
                      <p className="text-sm font-medium text-grey-10">
                        {importedFile.name}
                      </p>
                      <p className="text-xs text-grey-50">
                        {truncateAddress(importedFile.address, 8, 8)}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={clearImportFile}
                    className="p-1 text-grey-50 hover:text-grey-30 transition-colors"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Info box */}
            <div className="w-full bg-primary-50/5 border border-primary-50/20 rounded-lg p-4 mb-4">
              <div className="flex items-start gap-3">
                <Icons.InfoCircle className="size-5 text-primary-50 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-grey-40">
                  <p>
                    Your wallet will be imported with its original encryption.
                    You&apos;ll need your original passcode when signing transactions.
                  </p>
                </div>
              </div>
            </div>

            {/* Error */}
            {importError && (
              <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
                <AlertTriangle className="size-4 flex-shrink-0" />
                <span>{importError}</span>
              </div>
            )}

            <div className="flex gap-3 w-full">
              <CardButton
                variant="secondary"
                className="flex-1 h-10"
                onClick={closeImportDialog}
                disabled={isImporting}
              >
                Cancel
              </CardButton>
              <CardButton
                variant="dialog"
                className="flex-1 h-10"
                onClick={handleImportWallet}
                disabled={!importedFile || isImporting}
              >
                {isImporting ? "Importing..." : "Import Wallet"}
              </CardButton>
            </div>
          </div>
        </DialogContainer>
      </Dialog.Root>
    </>
  );
};

export default WalletSettings;
