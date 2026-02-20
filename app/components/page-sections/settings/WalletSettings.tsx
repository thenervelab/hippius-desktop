"use client";

import React, { useState, useCallback, useMemo, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Icons,
  RevealTextLine,
  CardButton,
  Input,
  Graphsheet,
} from "@/components/ui";
import { toast } from "sonner";
import SectionHeader from "./SectionHeader";
import { InView } from "react-intersection-observer";
import { useLocalWallet } from "@/app/contexts/LocalWalletContext";
import { LocalWallet } from "@/app/lib/helpers/localWalletDb";
import { AddWalletDialog } from "@/app/components/page-sections/wallet/local-wallet";
import DeleteConfirmationDialog from "@/components/DeleteConfirmationDialog";
import DialogContainer from "@/components/ui/DialogContainer";
import {
  Edit2,
  Download,
  AlertTriangle,
} from "lucide-react";
import {
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import * as TableModule from "@/components/ui/alt-table";
import { getWalletColumns } from "./WalletColumns";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import JSZip from "jszip";

// Column widths for the wallet table (defined outside component to avoid recreating)
const DEFAULT_COLUMN_WIDTHS = {
  wallet: 37,
  date_imported: 26,
  status: 32,
  actions: 5,
};

const MIN_COLUMN_WIDTHS = {
  wallet: 25,
  date_imported: 18,
  status: 20,
  actions: 5,
};

const WalletSettings: React.FC = () => {
  const {
    wallets,
    switchWallet,
    renameWallet,
    removeWallet,
  } = useLocalWallet();

  // Dialog states
  const [showAddWalletDialog, setShowAddWalletDialog] = useState(false);
  const [showImportWalletDialog, setShowImportWalletDialog] = useState(false);
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

  // Handle export wallet (no password needed - exports encrypted data)
  const handleExportClick = useCallback((wallet: LocalWallet) => {
    setWalletToExport(wallet);
    setShowExportDialog(true);
  }, []);

  const handleExportWallet = async () => {
    if (!walletToExport) return;

    setIsExporting(true);

    try {
      // Ask user where to save the file
      const defaultFileName = `hippius-wallet-${walletToExport.name.replace(/\s+/g, "-")}-backup.zip`;
      const filePath = await save({
        filters: [{ name: "ZIP File", extensions: ["zip"] }],
        defaultPath: defaultFileName,
      });

      if (!filePath) {
        // User cancelled the dialog
        setIsExporting(false);
        return;
      }

      // Export the encrypted wallet data directly (no decryption needed)
      const backupData = {
        version: 2, // Version 2 = encrypted backup format
        name: walletToExport.name,
        address: walletToExport.address,
        encryptedMnemonic: walletToExport.encryptedMnemonic,
        passwordHash: walletToExport.passwordHash,
        exportedAt: new Date().toISOString(),
      };

      // Create ZIP file containing the wallet backup JSON
      const zip = new JSZip();
      zip.file("wallet-backup.json", JSON.stringify(backupData, null, 2));
      const zipContent = await zip.generateAsync({ type: "uint8array" });

      // Write the ZIP file to the selected location
      await writeFile(filePath, zipContent);

      toast.success("Wallet backup saved successfully");
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

  // Copy address to clipboard
  const handleCopyAddress = useCallback((address: string) => {
    navigator.clipboard.writeText(address);
    toast.success("Address copied to clipboard");
  }, []);

  // Memoized columns
  const columns = useMemo(() => getWalletColumns({
    onCopyAddress: handleCopyAddress,
    onMakeActive: handleMakeActive,
    onEdit: handleEditClick,
    onExport: handleExportClick,
    onDelete: handleDeleteClick,
  }), [handleCopyAddress, handleMakeActive, handleEditClick, handleExportClick, handleDeleteClick]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wallets needed to force re-render when data changes
    [table, columnWidths, wallets]
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
                      learnMoreUrl="https://docs.hippius.com/use/desktop/settings#wallet-settings"
                      helpButtonOnly
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
                        onClick={() => setShowImportWalletDialog(true)}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Icons.DocumentDownload className="size-4" />
                          Import Wallet
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
                  <TableModule.TableWrapper className="bg-white">
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

      {/* Import Wallet Dialog */}
      <AddWalletDialog
        open={showImportWalletDialog}
        onClose={() => setShowImportWalletDialog(false)}
        initialStep="import"
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
            <div className="size-14 flex justify-center items-center relative mb-4">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: [49, 103, 211, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                <Edit2 className="size-5 text-white" />
              </div>
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
            <div className="size-14 flex justify-center items-center relative mb-4">
              <Graphsheet
                majorCell={{
                  lineColor: [31, 80, 189, 1.0],
                  lineWidth: 2,
                  cellDim: 200,
                }}
                minorCell={{
                  lineColor: [49, 103, 211, 1.0],
                  lineWidth: 1,
                  cellDim: 20,
                }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                <Download className="size-5 text-white" />
              </div>
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
                    your password when signing transactions after importing.
                  </p>
                  <p className="text-amber-600">
                    <strong className="text-amber-700">Warning:</strong> Keep this backup file
                    secure. Anyone with this file and your password can access
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
    </>
  );
};

export default WalletSettings;
