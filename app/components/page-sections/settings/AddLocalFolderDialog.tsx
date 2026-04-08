"use client";

import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CardButton, Graphsheet } from "@/components/ui";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Folder } from "lucide-react";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { invoke } from "@tauri-apps/api/core";
import { getHcfsConfig, saveHcfsConfig } from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";
import { isSyncConfiguredAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { appStore } from "@/lib/store/jotaiStore";
import DialogContainer from "@/components/ui/DialogContainer";

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
  const { polkadotAddress, getMnemonic } = useWalletAuth();
  const { checkEligibility } = useCreditCheck();
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [folderName, setFolderName] = useState<string>("");
  const [isAdding, setIsAdding] = useState(false);
  const [showHcfsSetup, setShowHcfsSetup] = useState(false);

  const handleSelectFolder = async () => {
    try {
      let defaultPath: string | undefined;
      try {
        const { homeDir } = await import("@tauri-apps/api/path");
        defaultPath = await homeDir();
      } catch {
        // Fall back to OS default if homeDir is unavailable
      }
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Folder to Sync",
        defaultPath,
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
      const mnemonic = (await getMnemonic()) ?? undefined;

      // Single Rust call: generates label, sets path, initializes sync
      await invoke<string>("add_local_sync_folder", {
        accountId: polkadotAddress,
        path: selectedPath,
        folderName,
        mnemonic: mnemonic ?? null,
      });

      // Engine status flips to "active" via the SYNC_ENGINE_STATUS_CHANGED
      // event from Rust — see useSyncEngineStatus.
      appStore.set(isSyncConfiguredAtom, true);

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

    // Live Rust eligibility check (replaces legacy stale-cache gate).
    // The Rust `add_local_sync_folder` IPC also enforces this internally
    // via `require_eligible(...)?` so the gate is impossible to bypass.
    if (!(await checkEligibility("folder-sync"))) {
      handleClose();
      return;
    }

    // Check if HCFS config (encryption password) exists
    try {
      const config = await getHcfsConfig(polkadotAddress);
      if (!config.has_password) {
        onClose();
        setShowHcfsSetup(true);
        return;
      }
    } catch {
      onClose();
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
      // Save config first — add_local_sync_folder needs it for init
      await saveHcfsConfig(polkadotAddress, result.serverUrl, result.password);
      setShowHcfsSetup(false);
      // doAdd → add_local_sync_folder handles mnemonic persistence during init
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
      <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit" preventClose={isAdding}>
        <Dialog.Title className="sr-only">Add Local Folder</Dialog.Title>

        <div className="px-4 py-6 flex flex-col gap-5">
          {/* Centered icon header */}
          <div className="flex flex-col items-center text-center gap-3">
            <div className="size-14 flex justify-center items-center relative">
              <Graphsheet
                majorCell={{ lineColor: [31, 80, 189, 1.0], lineWidth: 2, cellDim: 200 }}
                minorCell={{ lineColor: [49, 103, 211, 1.0], lineWidth: 1, cellDim: 20 }}
                className="absolute w-full h-full duration-500 opacity-30 z-0"
              />
              <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
              <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                <Folder className="size-5 text-grey-100" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold text-grey-10">Add Local Folder</h2>
              <p className="text-sm text-grey-50 max-w-sm">
              Select a folder from this device to sync
            </p>
            </div>
          </div>

          {/* Folder Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-grey-30">
              Selected Folder
            </label>
            {selectedPath ? (
              <div className="p-3 border border-grey-80 rounded-lg bg-grey-98">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-grey-60 break-all font-mono bg-white px-2 py-1.5 rounded border border-grey-90">
                      {selectedPath}
                    </p>
                  </div>
                  <button
                    className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-primary-50 bg-white border border-primary-50 rounded hover:bg-primary-50 hover:text-white transition-colors"
                    onClick={handleSelectFolder}
                    disabled={isAdding}
                  >
                    Change
                  </button>
                </div>
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
          <div className="p-3 bg-primary-95 border border-primary-80 rounded-lg">
            <p className="text-xs text-primary-40">
              All files in this folder will be encrypted and synced to the
              Hippius network. Changes will automatically sync across your
              devices.
            </p>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <CardButton
              className="w-full"
              variant="secondary"
              onClick={handleClose}
              disabled={isAdding}
            >
              Cancel
            </CardButton>
            <CardButton
              className="w-full"
              variant="primary"
              onClick={handleAddFolder}
              disabled={!selectedPath || isAdding}
              loading={isAdding}
            >
              {isAdding ? "Adding..." : "Add Folder"}
            </CardButton>
          </div>
        </div>
      </DialogContainer>
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
