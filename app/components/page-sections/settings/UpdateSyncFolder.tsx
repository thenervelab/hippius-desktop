"use client";

import React, { useState, useEffect } from "react";
import { InView } from "react-intersection-observer";
import SectionHeader from "./SectionHeader";
import SyncFolderSelector from "@/app/components/page-sections/files/SyncFolderSelector";
import {
  getPrivateSyncPath,
  setPrivateSyncPath,
} from "@/app/lib/utils/syncPathUtils";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useSetAtom } from "jotai";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
// NOTE: this component used to render a "Stop Syncing" / "Start Syncing"
// button pair plus the global "Syncing is currently stopped" banner.
// All three were single-drive remnants — the Stop button was hardcoded
// to `label: "default"` and the banner conflated multi-drive state into
// a single global enum. They were deleted in the per-drive status
// migration. Per-drive lifecycle (pause / resume / remove) lives in
// `MultiFolderSyncManager`'s 3-dot menu now. This page is now solely
// responsible for choosing the local folder LOCATION.
import { SyncConnectivityAlert } from "@/components/ui/SyncConnectivityAlert";
import { SyncPausedAlert, IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";
import { HcfsSetupDialog } from "./HcfsSetupDialog";
import { MnemonicBackupDialog } from "./MnemonicBackupDialog";
import { useHcfsSync } from "@/app/lib/hooks/useHcfsSync";
import { invoke } from "@tauri-apps/api/core";

const UpdateSyncFolder: React.FC = () => {
  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] =
    useState("");
  const [selectedPrivateFolderName, setSelectedPrivateFolderName] =
    useState("");
  const { polkadotAddress, getMnemonic } = useWalletAuth();
  const [showSelector, setShowSelector] = useState(false);
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);

  const {
    setupAndInitialize,
    checkConfig,
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
  } = useHcfsSync();

  const [showHcfsSetup, setShowHcfsSetup] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);

  // Load folder path on mount.
  useEffect(() => {
    (async () => {
      try {
        const privatefolderPath = (await getPrivateSyncPath(polkadotAddress ?? undefined))?.path ?? "";
        setSelectedPrivateFolderPath(privatefolderPath);
        setSelectedPrivateFolderName(
          privatefolderPath.split(/[\\\/]/).pop() || ""
        );
      } catch (err) {
        console.error("Failed to load sync folder:", err);
      }
    })();
  }, [polkadotAddress]);

  const handlePrivateFolderSelected = async (path: string) => {
    if (!polkadotAddress) return;

    try {
      // Save sync path and update UI immediately (fast operations)
      await setPrivateSyncPath(path, polkadotAddress);
      setSelectedPrivateFolderPath(path);
      setSelectedPrivateFolderName(path.split(/[\\\/]/).pop() || "");

      // Trigger files page refresh
      triggerSyncPathRefresh((prev) => prev + 1);

      // Check if HCFS config exists
      const hasConfig = await checkConfig(polkadotAddress);

      if (!hasConfig.has_password) {
        // Need to show setup dialog — user must enter password first
        setShowHcfsSetup(true);
      } else {
        // Config exists — show success immediately, sync in background
        toast.success("Sync folder set — syncing started!");
        setShowSelector(false);
        // Per-drive Active status is emitted by Rust automatically when
        // change_sync_folder re-initializes the drive — useDriveStatuses
        // picks it up via the DRIVE_STATUS_CHANGED event.

        // Single Rust call: removes old drive, sets path, initializes new drive
        const mnemonic = (await getMnemonic()) ?? undefined;
        invoke("change_sync_folder", {
          accountId: polkadotAddress,
          newPath: path,
          label: "default",
          mnemonic: mnemonic ?? null,
        }).catch((err) => console.error("[UpdateSyncFolder] change_sync_folder failed:", err));
      }
    } catch (err) {
      console.error("Failed to update sync path:", err);
      toast.error("Failed to set sync folder");
    }
  };

  const handleHcfsSetupComplete = async (result: { serverUrl: string; password: string }) => {
    if (!polkadotAddress) return;

    try {
      const mnemonic = (await getMnemonic()) ?? undefined;
      const initResult = await setupAndInitialize(
        polkadotAddress,
        "default",
        result.serverUrl,
        result.password,
        mnemonic ?? undefined
      );

      setShowHcfsSetup(false);
      // Close the folder selector view to show the updated folder
      setShowSelector(false);

      if (initResult) {
        toast.success("Sync folder set — syncing started!");
        // Per-drive Active status is emitted by Rust automatically.
        if (initResult.mnemonic) {
          setShowMnemonicBackup(true);
        }
      }
    } catch (err) {
      console.error("Failed to setup HCFS:", err);
      toast.error("Sync setup failed. Please try again.");
    }
  };

  const handleMnemonicBackupConfirm = () => {
    setShowMnemonicBackup(false);
    clearMnemonicBackup();
  };

  const handleBackClick = () => {
    setShowSelector(false);
  };

  return (
    <>
      <InView triggerOnce>
        {({ inView, ref }) => (
          <div
            ref={ref}
            className="flex flex-col w-full relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover border border-grey-80 rounded-lg overflow-hidden"
          >
            <div className="relative w-full">
              {/* Main Settings View */}
              <div
                className={cn(
                  "w-full p-4 transition-all duration-500 ease-in-out",
                  showSelector
                    ? "absolute top-0 left-0 opacity-0 pointer-events-none transform -translate-x-full"
                    : "relative opacity-100 pointer-events-auto transform translate-x-0"
                )}
              >
                <RevealTextLine
                  rotate
                  reveal={inView && !showSelector}
                  parentClassName="w-full"
                  className="delay-300 w-full"
                >
                  <div className="flex flex-col w-full">
                    <SectionHeader
                      Icon={Icons.File2}
                      title="Change your sync folder"
                      subtitle="Choose a folder to keep your files in sync with Hippius. If you edit or remove files, those changes will be automatically synced."
                      info="Sync folder connects your local storage with our decentralized network, providing both convenience and blockchain-backed security for your files."
                      learnMoreUrl="https://docs.hippius.com/use/desktop/settings#selecting-sync-folder"
                    />
                    {/* Sync Paused Alert */}
                    {IS_SYNC_PAUSED && (
                      <div className="mt-4">
                        <SyncPausedAlert variant="banner" />
                      </div>
                    )}
                    {/* Sync connectivity alert. The "Syncing is currently
                        stopped" banner that used to live here was deleted in
                        the per-drive status migration. */}
                    <div className="mt-4 space-y-2">
                      <SyncConnectivityAlert variant="banner" />
                    </div>
                    <div className={cn("flex justify-between p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full", IS_SYNC_PAUSED && "opacity-60")}>
                      {selectedPrivateFolderName ? (
                        <div className="flex-1">
                          <div className="flex">
                            <Icons.Folder className="size-4 mr-[0.375rem] text-grey-40" />
                            <span className="font-medium text-base text-grey-40 -mt-0.5">
                              {selectedPrivateFolderName}
                            </span>
                            <div className="-mt-1 ml-4 px-2 py-1 text-xs rounded bg-primary-90 text-primary-50 font-medium border border-grey-80">
                              Private
                            </div>
                          </div>

                          <p className="text-sm text-grey-60 mt-1 ml-6">
                            {selectedPrivateFolderPath}
                          </p>
                        </div>
                      ) : (
                        <div className="flex items-center text-sm text-grey-60">
                          No private sync folder set. You can set a private sync
                          folder to sync your files securely.
                        </div>
                      )}
                      <div className="flex self-start gap-3">
                        {/* The Start / Stop / Stopping button trio that used
                            to live here was a single-drive remnant hardcoded
                            to label="default". Per-drive lifecycle (pause /
                            resume / remove) is now handled by the 3-dot menu
                            in MultiFolderSyncManager. */}
                        <CardButton
                          className="max-w-[10rem] h-10"
                          variant="primary"
                          disabled={IS_SYNC_PAUSED}
                          onClick={() => {
                            if (IS_SYNC_PAUSED) {
                              toast.info("Sync is temporarily paused while we transition to a new sync engine. Coming back soon!");
                              return;
                            }
                            setShowSelector(true);
                          }}
                        >
                          <span className="text-base leading-4 font-medium">
                            {IS_SYNC_PAUSED
                              ? "Sync Paused"
                              : selectedPrivateFolderName
                                ? "Change Folder"
                                : "Select Folder"}
                          </span>
                        </CardButton>
                      </div>
                    </div>
                  </div>
                </RevealTextLine>
              </div>

              {/* Folder Selector View */}
              <div
                className={cn(
                  "w-full p-4 transition-all duration-500 ease-in-out",
                  showSelector
                    ? "relative opacity-100 pointer-events-auto transform translate-x-0"
                    : "absolute top-0 left-0 opacity-0 pointer-events-none transform translate-x-full"
                )}
              >
                <RevealTextLine
                  rotate
                  reveal={inView && showSelector}
                  parentClassName="w-full"
                  className="delay-300 w-full"
                >
                  <SyncFolderSelector
                    initialPath={selectedPrivateFolderPath}
                    handleBackClick={handleBackClick}
                    isFromSettingsPage
                    onFolderSelected={handlePrivateFolderSelected}
                  />
                </RevealTextLine>
              </div>
            </div>

          </div>
        )}
      </InView>

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => setShowHcfsSetup(false)}
        onComplete={handleHcfsSetupComplete}
        loading={isInitializing}
      />

      {mnemonicToBackup && (
        <MnemonicBackupDialog
          open={showMnemonicBackup}
          mnemonic={mnemonicToBackup}
          onConfirm={handleMnemonicBackupConfirm}
          onClose={handleMnemonicBackupConfirm}
        />
      )}
    </>
  );
};

export default UpdateSyncFolder;
