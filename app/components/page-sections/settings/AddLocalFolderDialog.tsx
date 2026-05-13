"use client";

import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { OctagonAlert, ArrowRight, Folder } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button, Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  getHcfsConfig,
  saveHcfsConfig,
} from "@/app/lib/utils/hcfsConfigUtils";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";

interface AddLocalFolderDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Add Local Folder dialog using the FramedDialog shell. The dropzone
 * supports both clicking to open the native folder picker and dragging
 * a folder from the OS — drag-drop uses Tauri's tauri://drag-drop
 * window event and filters out file drops (only directories are valid
 * sync sources).
 */
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
  const [isDragging, setIsDragging] = useState(false);
  const [showHcfsSetup, setShowHcfsSetup] = useState(false);

  const handleSelectFolder = useCallback(async () => {
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
        const name = path.split(/[\\/]/).pop() || "";
        setFolderName(name);
      }
    } catch (error) {
      console.error("Failed to select folder:", error);
      toast.error("Failed to select folder");
    }
  }, []);

  // Tauri native drag-drop: accept exactly one dropped directory.
  // Listeners are only registered while the dialog is open so we don't
  // hijack drops in other surfaces.
  useEffect(() => {
    if (!open) return;
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { stat } = await import("@tauri-apps/plugin-fs");

        const unDragEnter = await listen("tauri://drag-enter", () => {
          setIsDragging(true);
        });
        unlisteners.push(unDragEnter);

        const unDragLeave = await listen("tauri://drag-leave", () => {
          setIsDragging(false);
        });
        unlisteners.push(unDragLeave);

        const unDragDrop = await listen<{ paths: string[] }>(
          "tauri://drag-drop",
          async (event) => {
            setIsDragging(false);
            const paths = event.payload.paths;
            if (!paths || paths.length === 0) return;

            // Only accept a single directory drop.
            const first = paths[0];
            try {
              const info = await stat(first);
              if (!info.isDirectory) {
                toast.error(
                  "Only folders can be added here. Drop a folder, not a file."
                );
                return;
              }
            } catch (err) {
              console.error("[AddLocalFolderDialog] stat failed:", err);
              toast.error("Could not read the dropped item. Try again.");
              return;
            }

            if (paths.length > 1) {
              toast.info("Only the first dropped folder will be used.");
            }

            setSelectedPath(first);
            setFolderName(first.split(/[\\/]/).pop() || "");
          }
        );
        unlisteners.push(unDragDrop);
      } catch (err) {
        console.error(
          "[AddLocalFolderDialog] Failed to register drag listeners:",
          err
        );
      }
    })();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [open]);

  const doAdd = async () => {
    if (!polkadotAddress || !selectedPath) return;

    setIsAdding(true);
    try {
      const mnemonic = (await getMnemonic()) ?? undefined;

      await invoke<string>("add_local_sync_folder", {
        accountId: polkadotAddress,
        path: selectedPath,
        folderName,
        mnemonic: mnemonic ?? null,
      });

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

    if (!(await checkEligibility("folder-sync"))) {
      handleClose();
      return;
    }

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
      await saveHcfsConfig(polkadotAddress, result.serverUrl, result.password);
      setShowHcfsSetup(false);
      await doAdd();
    } catch (err) {
      console.error("Failed to save HCFS config:", err);
      toast.error("Sync setup failed. Please try again.");
    }
  };

  const handleClose = () => {
    if (isAdding) return;
    setSelectedPath("");
    setFolderName("");
    setIsDragging(false);
    onClose();
  };

  return (
    <>
      <FramedDialog
        open={open}
        onClose={handleClose}
        title="Add a Local Folder"
        icon={<Icons.FolderPlus className="size-5 text-white" />}
        maxWidth="max-w-[680px]"
      >
        <p className="mb-5 text-center text-sm text-[#7D7D7D] dark:text-grey-dark-600">
          Select a folder from this device to sync
        </p>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-xs text-grey-40 dark:text-grey-dark-600">
              Upload Folder
            </span>

            <button
              type="button"
              onClick={handleSelectFolder}
              disabled={isAdding}
              className={cn(
                "flex w-full flex-col items-center justify-center gap-3 rounded-[8px] border-2 border-dashed px-6 py-8 transition-colors",
                "border-grey-80 bg-white hover:bg-[#fafafa]",
                "dark:border-[#3a3a3a] dark:bg-[#1f1f1f] dark:hover:bg-[#252525]",
                isDragging &&
                  "border-primary-50 bg-primary-50/5 dark:border-primary-50 dark:bg-primary-50/10",
                isAdding && "opacity-60 cursor-not-allowed"
              )}
            >
              {selectedPath ? (
                <div className="flex w-full items-center justify-center gap-3">
                  <Folder className="size-5 text-primary-50 flex-shrink-0" />
                  <p className="font-mono text-xs text-grey-40 dark:text-grey-dark-300 break-all text-left">
                    {selectedPath}
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex size-10 items-center justify-center rounded-[6px] bg-[#3167dd]">
                    <Icons.FolderPlus className="size-5 text-white" />
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <p className="font-geist text-[16px] font-medium leading-[20px] tracking-[-0.32px] text-grey-10 dark:text-white">
                      Select Folder
                    </p>
                    <p className="font-geist text-[14px] font-normal leading-[18px] tracking-[-0.28px] text-[#7D7D7D] dark:text-grey-dark-600 text-center">
                      Drag and drop or click to add folder here to upload
                    </p>
                  </div>
                </>
              )}
            </button>
          </div>

          {/* Important callout */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <OctagonAlert className="size-4 text-[#feb101]" />
              <p className="font-geist text-[14px] leading-[1.109] tracking-[-0.28px] font-medium text-black dark:text-white">
                Important
              </p>
            </div>
            <div className="flex items-start gap-2">
              <ArrowRight className="mt-0.5 size-4 flex-shrink-0 text-[#E3E3E3] dark:text-[#3a3a3a]" />
              <p className="font-geist text-[14px] leading-[1.4] tracking-[-0.28px] text-[#4F4F4F] dark:text-grey-dark-600">
                All files in this folder will be encrypted and synced to the
                Hippius network. Changes will automatically sync across your
                devices.
              </p>
            </div>
          </div>

          {/* Actions */}
          <Button
            variant="primary"
            size="auto"
            onClick={handleAddFolder}
            disabled={!selectedPath || isAdding}
            loading={isAdding}
            className={cn(
              "h-[52px] w-full rounded-[6px] border text-sm font-medium",
              "border-[#3167DD] bg-[#3167DD] text-white",
              "hover:bg-[#2454c4] hover:border-[#2454c4]",
              "dark:hover:bg-[#2a5ad0] dark:hover:border-[#2a5ad0]"
            )}
          >
            {isAdding ? "Adding..." : "Add Folder"}
          </Button>

          <Button
            variant="defaultStable"
            size="auto"
            onClick={handleClose}
            disabled={isAdding}
            className={cn(
              "h-[52px] w-full rounded-[6px] border text-sm font-medium",
              "border-grey-dark-100 bg-[#FEFEFE] text-[#111]",
              "shadow-[0_5px_2.3px_rgba(0,0,0,0.03),0_1px_1.9px_rgba(0,0,0,0.14),0_0_1px_rgba(0,0,0,0.16),inset_0_1px_0_#FFF]",
              "hover:bg-[#F5F5F5]",
              "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-300 dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)] dark:hover:bg-black-500"
            )}
          >
            Cancel
          </Button>
        </div>
      </FramedDialog>

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => setShowHcfsSetup(false)}
        onComplete={handleHcfsSetupComplete}
        loading={isAdding}
      />
    </>
  );
};
