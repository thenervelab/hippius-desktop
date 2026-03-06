"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CardButton, Icons } from "@/components/ui";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { X, Folder } from "lucide-react";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { setPrivateSyncPath, getAllSyncPaths } from "@/app/lib/utils/syncPathUtils";
import { getHcfsConfig, saveHcfsConfig, initializeSync } from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";

interface AddLocalFolderDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const AddLocalFolderDialog: React.FC<AddLocalFolderDialogProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { polkadotAddress, getMnemonic, authType } = useWalletAuth();
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [folderName, setFolderName] = useState<string>("");
  const [isAdding, setIsAdding] = useState(false);
  const [showHcfsSetup, setShowHcfsSetup] = useState(false);

  const handleSelectFolder = async () => {
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Folder to Sync",
      });

      if (typeof path === "string") {
        setSelectedPath(path);
        // Extract folder name from path
        const name = path.split(/[\\\/]/).pop() || "";
        setFolderName(name);
      }
    } catch (error) {
      console.error("Failed to select folder:", error);
      toast.error("Failed to select folder");
    }
  };

  const doAdd = async () => {
    if (!polkadotAddress || !selectedPath) return;

    setIsAdding(true);
    try {
      const mnemonic =
        authType === "mnemonic" ? (await getMnemonic()) ?? undefined : undefined;

      // Deduplicate label: if "Documents" exists, try "Documents-2", "Documents-3", etc.
      const existingPaths = await getAllSyncPaths(polkadotAddress).catch(() => []);
      const existingLabels = new Set(existingPaths.map((p) => p.label));
      let label = folderName;
      let suffix = 2;
      while (existingLabels.has(label)) {
        label = `${folderName}-${suffix}`;
        suffix++;
      }

      await setPrivateSyncPath(selectedPath, polkadotAddress, label);
      await initializeSync(polkadotAddress, label, mnemonic);

      toast.success("Folder added to sync");
      setSelectedPath("");
      setFolderName("");
      onSuccess();
      onClose();
    } catch (error) {
      console.error("Failed to add folder:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to add folder"
      );
    } finally {
      setIsAdding(false);
    }
  };

  const handleAddFolder = async () => {
    if (!polkadotAddress) {
      toast.error("Wallet authentication is required");
      return;
    }

    if (!selectedPath) {
      toast.error("Please select a folder first");
      return;
    }

    // Check if HCFS config (encryption password) exists
    try {
      const config = await getHcfsConfig(polkadotAddress);
      if (!config.has_password) {
        setShowHcfsSetup(true);
        return;
      }
    } catch {
      setShowHcfsSetup(true);
      return;
    }

    await doAdd();
  };

  const handleHcfsSetupComplete = async (result: {
    serverUrl: string;
    password: string;
  }) => {
    if (!polkadotAddress) return;

    try {
      await saveHcfsConfig(polkadotAddress, result.serverUrl, result.password);
      setShowHcfsSetup(false);
      await doAdd();
    } catch (err) {
      console.error("Failed to save HCFS config:", err);
      toast.error("Sync setup failed. Please try again.");
    }
  };

  const handleClose = () => {
    if (!isAdding) {
      setSelectedPath("");
      setFolderName("");
      onClose();
    }
  };

  return (
    <>
    <Dialog.Root open={open} onOpenChange={handleClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl p-6 w-full max-w-md z-50">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary-95 rounded-lg">
                <Folder className="size-5 text-primary-50" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-semibold text-grey-10">
                  Add Local Folder
                </Dialog.Title>
                <Dialog.Description className="text-sm text-grey-60">
                  Select a folder from this device to sync
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                className="p-1 hover:bg-grey-95 rounded transition-colors"
                disabled={isAdding}
              >
                <X className="size-5 text-grey-50" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            {/* Folder Selection */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-grey-30">
                Selected Folder
              </label>
              {selectedPath ? (
                <div className="p-4 border border-grey-80 rounded-lg bg-grey-98">
                  <div className="flex items-center gap-2 mb-2">
                    <Folder className="size-4 text-grey-40 flex-shrink-0" />
                    <span className="font-medium text-base text-grey-10">
                      {folderName}
                    </span>
                  </div>
                  <p className="text-xs text-grey-60 break-all">{selectedPath}</p>
                  <CardButton
                    variant="ghost"
                    className="mt-2 text-sm"
                    onClick={handleSelectFolder}
                    disabled={isAdding}
                  >
                    Change Folder
                  </CardButton>
                </div>
              ) : (
                <CardButton
                  variant="secondary"
                  className="w-full justify-center"
                  icon={<Folder className="size-4" />}
                  appendToStart
                  onClick={handleSelectFolder}
                  disabled={isAdding}
                >
                  Select Folder
                </CardButton>
              )}
            </div>

            {/* Info Box */}
            <div className="p-3 bg-primary-98 border border-primary-90 rounded-lg">
              <p className="text-xs text-primary-40">
                All files in this folder will be encrypted and synced to the
                Hippius network. Changes will automatically sync across your
                devices.
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-2">
              <CardButton
                variant="secondary"
                className="flex-1"
                onClick={handleClose}
                disabled={isAdding}
              >
                Cancel
              </CardButton>
              <CardButton
                variant="primary"
                className="flex-1"
                onClick={handleAddFolder}
                disabled={!selectedPath || isAdding}
              >
                {isAdding ? (
                  <>
                    <Icons.Loader className="size-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  "Add Folder"
                )}
              </CardButton>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => setShowHcfsSetup(false)}
        onComplete={handleHcfsSetupComplete}
        loading={isAdding}
      />
    </>
  );
};
