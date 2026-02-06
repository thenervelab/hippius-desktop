"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import DialogContainer from "@/components/ui/DialogContainer";
import { AbstractIconWrapper, CardButton, Icons, Input } from "@/components/ui";
import { useLocalWallet, LocalWallet } from "@/app/contexts/LocalWalletContext";
import PasscodeInput from "./PasscodeInput";
import {
  X,
  Download,
  Trash2,
  Edit3,
  AlertCircle,
  Check,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { encryptMnemonic } from "@/app/lib/helpers/crypto";

interface WalletSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type SettingsView = "main" | "rename" | "export" | "delete";

const WalletSettingsDialog: React.FC<WalletSettingsDialogProps> = ({
  open,
  onClose,
}) => {
  const {
    activeWallet,
    wallets,
    renameWallet,
    removeWallet,
    getDecryptedMnemonic,
    truncateAddress,
  } = useLocalWallet();

  const [view, setView] = useState<SettingsView>("main");
  const [selectedWalletId, setSelectedWalletId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const selectedWallet = wallets.find((w: LocalWallet) => w.id === selectedWalletId);

  const resetState = () => {
    setView("main");
    setSelectedWalletId(null);
    setNewName("");
    setPasscode("");
    setError(null);
    setIsLoading(false);
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const handleRenameClick = (walletId: number, currentName: string) => {
    setSelectedWalletId(walletId);
    setNewName(currentName);
    setView("rename");
  };

  const handleExportClick = (walletId: number) => {
    setSelectedWalletId(walletId);
    setView("export");
  };

  const handleDeleteClick = (walletId: number) => {
    setSelectedWalletId(walletId);
    setView("delete");
  };

  const handleRename = async () => {
    if (!selectedWalletId || !newName.trim()) {
      setError("Please enter a wallet name");
      return;
    }

    setIsLoading(true);
    try {
      const success = await renameWallet(selectedWalletId, newName.trim());
      if (success) {
        toast.success("Wallet renamed successfully");
        resetState();
      } else {
        setError("Failed to rename wallet");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename wallet");
    } finally {
      setIsLoading(false);
    }
  };

  const handleExport = async () => {
    if (!selectedWalletId || !passcode) {
      setError("Please enter your passcode");
      return;
    }

    setIsLoading(true);
    try {
      const mnemonic = getDecryptedMnemonic(passcode);
      if (!mnemonic) {
        setError("Incorrect passcode");
        setIsLoading(false);
        return;
      }

      // Re-encrypt with the same passcode for export
      const encryptedMnemonic = encryptMnemonic(mnemonic, passcode);

      const exportData = {
        name: selectedWallet?.name || "Wallet",
        address: selectedWallet?.address,
        encryptedMnemonic,
        exportedAt: new Date().toISOString(),
        version: "1.0",
      };

      // Create and download file
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hippius-wallet-${selectedWallet?.name?.replace(/\s+/g, "-") || "backup"}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("Wallet exported successfully");
      resetState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export wallet");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedWalletId || !passcode) {
      setError("Please enter your passcode");
      return;
    }

    // Verify passcode
    const mnemonic = getDecryptedMnemonic(passcode);
    if (!mnemonic) {
      setError("Incorrect passcode");
      return;
    }

    setIsLoading(true);
    try {
      const success = await removeWallet(selectedWalletId);
      if (success) {
        toast.success("Wallet deleted successfully");
        resetState();
      } else {
        setError("Failed to delete wallet");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete wallet");
    } finally {
      setIsLoading(false);
    }
  };

  const renderMainView = () => (
    <div className="flex flex-col px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-grey-10">Wallet Settings</h2>
      </div>

      <div className="space-y-3 max-h-[400px] overflow-y-auto">
        {wallets.map((wallet: LocalWallet) => {
          const isActive = activeWallet?.id === wallet.id;
          return (
            <div
              key={wallet.id}
              className="p-4 border border-grey-80 rounded-lg bg-white"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary-90 flex items-center justify-center">
                    <Icons.Wallet className="size-4 text-primary-50" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-grey-10">
                        {wallet.name}
                      </p>
                      {isActive && (
                        <span className="px-2 py-0.5 text-xs font-medium text-primary-50 bg-primary-95 rounded">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-grey-50">
                      {truncateAddress(wallet.address, 8, 6)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleRenameClick(wallet.id, wallet.name)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-grey-50 border border-grey-80 rounded hover:bg-grey-95 transition-colors"
                >
                  <Edit3 className="size-3" />
                  Rename
                </button>
                <button
                  onClick={() => handleExportClick(wallet.id)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-grey-50 border border-grey-80 rounded hover:bg-grey-95 transition-colors"
                >
                  <Download className="size-3" />
                  Export
                </button>
                <button
                  onClick={() => handleDeleteClick(wallet.id)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-error-60 border border-error-80 rounded hover:bg-error-95 transition-colors"
                  disabled={wallets.length === 1}
                >
                  <Trash2 className="size-3" />
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderRenameView = () => (
    <div className="flex flex-col items-center px-6 py-8">
      <AbstractIconWrapper className="size-16 text-primary-40 mb-6">
        <Edit3 className="absolute size-6 text-primary-50" />
      </AbstractIconWrapper>

      <h2 className="text-xl font-semibold text-grey-10 mb-6">Rename Wallet</h2>

      <div className="w-full mb-6">
        <label className="text-sm font-medium text-grey-60 mb-2 block">
          Wallet Name
        </label>
        <Input
          type="text"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setError(null);
          }}
          placeholder="Enter new wallet name"
          className="w-full h-14 text-grey-10"
          disabled={isLoading}
          autoFocus
        />
      </div>

      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="w-full flex gap-3">
        <CardButton
          className="flex-1 h-12"
          variant="secondary"
          onClick={() => {
            setView("main");
            setError(null);
          }}
          disabled={isLoading}
        >
          Cancel
        </CardButton>
        <CardButton
          className="flex-1 h-12"
          onClick={handleRename}
          disabled={isLoading || !newName.trim()}
          loading={isLoading}
        >
          <div className="flex items-center justify-center gap-2">
            <Check className="size-4" />
            Save
          </div>
        </CardButton>
      </div>
    </div>
  );

  const renderExportView = () => (
    <div className="flex flex-col items-center px-6 py-8">
      <AbstractIconWrapper className="size-16 text-primary-40 mb-6">
        <Download className="absolute size-6 text-primary-50" />
      </AbstractIconWrapper>

      <h2 className="text-xl font-semibold text-grey-10 mb-2">Export Wallet</h2>
      <p className="text-sm text-grey-60 text-center mb-6">
        Enter your passcode to export {selectedWallet?.name}
      </p>

      <div className="w-full mb-6">
        <PasscodeInput
          value={passcode}
          onChange={(val) => {
            setPasscode(val);
            setError(null);
          }}
          label="Passcode"
          placeholder="Enter your passcode"
          disabled={isLoading}
          autoFocus
          onSubmit={handleExport}
        />
      </div>

      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="w-full flex gap-3">
        <CardButton
          className="flex-1 h-12"
          variant="secondary"
          onClick={() => {
            setView("main");
            setPasscode("");
            setError(null);
          }}
          disabled={isLoading}
        >
          Cancel
        </CardButton>
        <CardButton
          className="flex-1 h-12"
          onClick={handleExport}
          disabled={isLoading || !passcode}
          loading={isLoading}
        >
          <div className="flex items-center justify-center gap-2">
            <Download className="size-4" />
            Export
          </div>
        </CardButton>
      </div>
    </div>
  );

  const renderDeleteView = () => (
    <div className="flex flex-col items-center px-6 py-8">
      <div className="size-16 rounded-full bg-error-95 flex items-center justify-center mb-6">
        <AlertTriangle className="size-8 text-error-60" />
      </div>

      <h2 className="text-xl font-semibold text-grey-10 mb-2">Delete Wallet</h2>
      <p className="text-sm text-grey-60 text-center mb-2">
        Are you sure you want to delete <strong>{selectedWallet?.name}</strong>?
      </p>
      <p className="text-xs text-error-60 text-center mb-6">
        This action cannot be undone. Make sure you&apos;ve backed up your mnemonic.
      </p>

      <div className="w-full mb-6">
        <PasscodeInput
          value={passcode}
          onChange={(val) => {
            setPasscode(val);
            setError(null);
          }}
          label="Enter passcode to confirm"
          placeholder="Enter your passcode"
          disabled={isLoading}
          autoFocus
          onSubmit={handleDelete}
        />
      </div>

      {error && (
        <div className="w-full flex items-center gap-2 text-error-70 text-sm font-medium mb-4 p-3 bg-error-95 rounded-lg">
          <AlertCircle className="size-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="w-full flex gap-3">
        <CardButton
          className="flex-1 h-12"
          variant="secondary"
          onClick={() => {
            setView("main");
            setPasscode("");
            setError(null);
          }}
          disabled={isLoading}
        >
          Cancel
        </CardButton>
        <CardButton
          className="flex-1 h-12 bg-error-60 hover:bg-error-50"
          onClick={handleDelete}
          disabled={isLoading || !passcode}
          loading={isLoading}
        >
          <div className="flex items-center justify-center gap-2">
            <Trash2 className="size-4" />
            Delete
          </div>
        </CardButton>
      </div>
    </div>
  );

  const renderView = () => {
    switch (view) {
      case "main":
        return renderMainView();
      case "rename":
        return renderRenameView();
      case "export":
        return renderExportView();
      case "delete":
        return renderDeleteView();
      default:
        return renderMainView();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[500px] h-fit">
        <Dialog.Title className="sr-only">Wallet Settings</Dialog.Title>

        {/* Close Button */}
        <button
          onClick={handleClose}
          className="absolute right-4 top-4 text-grey-50 hover:text-grey-30 transition-colors z-10"
        >
          <X className="size-5" />
        </button>

        {/* Back Button for sub-views */}
        {view !== "main" && (
          <button
            onClick={() => {
              setView("main");
              setPasscode("");
              setError(null);
            }}
            className="absolute left-4 top-4 text-grey-50 hover:text-grey-30 transition-colors z-10"
            disabled={isLoading}
          >
            <Icons.ArrowLeft className="size-5" />
          </button>
        )}

        {renderView()}
      </DialogContainer>
    </Dialog.Root>
  );
};

export default WalletSettingsDialog;
