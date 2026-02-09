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
import StopSyncDialog, { type SyncType } from "./StopSyncDialog";
import { useSetAtom } from "jotai";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
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
  const { polkadotAddress, getMnemonic, authType } = useWalletAuth();
  const [showSelector, setShowSelector] = useState(false);
  const [stopSyncTarget, setStopSyncTarget] = useState<SyncType | null>(null);
  const [isStoppingSync, setIsStoppingSync] = useState(false);
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);

  const {
    setupAndInitialize,
    tryInitializeSync,
    checkConfig,
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
  } = useHcfsSync();

  const [showHcfsSetup, setShowHcfsSetup] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const privatefolderPath = await getPrivateSyncPath(polkadotAddress ?? undefined);
        setSelectedPrivateFolderPath(privatefolderPath);
        setSelectedPrivateFolderName(
          privatefolderPath.split(/[\\/]/).pop() || ""
        );
      } catch {
        console.error("Failed to load sync folder");
      }
    })();
  }, [polkadotAddress]);

  const handlePrivateFolderSelected = async (path: string) => {
    if (!polkadotAddress) return;

    try {
      // Stop the existing sync loop before changing paths
      await invoke("stop_sync");

      await setPrivateSyncPath(path, polkadotAddress);

      // Update local state immediately
      setSelectedPrivateFolderPath(path);
      setSelectedPrivateFolderName(path.split(/[\\/]/).pop() || "");

      // Check if HCFS config exists
      const hasConfig = await checkConfig(polkadotAddress);

      if (!hasConfig.has_password) {
        setShowHcfsSetup(true);
      } else {
        // Config exists, just initialize with mnemonic from session
        const mnemonic = authType === "mnemonic" ? await getMnemonic() : undefined;
        await tryInitializeSync(polkadotAddress, mnemonic ?? undefined);
      }

      // Trigger files page refresh
      triggerSyncPathRefresh((prev) => prev + 1);
    } catch (err) {
      console.error("Failed to update sync path:", err);
    }
  };

  const handleHcfsSetupComplete = async (result: { serverUrl: string; password: string }) => {
    if (!polkadotAddress) return;

    const mnemonic = authType === "mnemonic" ? await getMnemonic() : undefined;
    const initResult = await setupAndInitialize(
      polkadotAddress,
      result.serverUrl,
      result.password,
      mnemonic ?? undefined
    );

    setShowHcfsSetup(false);

    if (initResult?.mnemonic) {
      setShowMnemonicBackup(true);
    }
  };

  const handleMnemonicBackupConfirm = () => {
    setShowMnemonicBackup(false);
    clearMnemonicBackup();
  };

  const handleBackClick = () => {
    setShowSelector(false);
  };

  const handleStopSyncConfirm = async () => {
    if (!stopSyncTarget) return;
    if (!polkadotAddress) {
      toast.error("Wallet authentication is required");
      return;
    }

    setIsStoppingSync(true);

    try {
      // Stop the Rust sync loop first
      await invoke("stop_sync");
      await setPrivateSyncPath("", polkadotAddress);
      setSelectedPrivateFolderPath("");
      setSelectedPrivateFolderName("");
      toast.success("Private folder syncing stopped");
      setStopSyncTarget(null);
      // Trigger files page refresh
      triggerSyncPathRefresh((prev) => prev + 1);
    } catch {
      toast.error("Failed to stop syncing for this folder");
    } finally {
      setIsStoppingSync(false);
    }
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
                    <div className={cn("flex justify-between p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full", IS_SYNC_PAUSED && "opacity-60")}>
                      {selectedPrivateFolderName ? (
                        <div className="flex-1">
                          <div className="flex">
                            <Icons.Folder className="size-4 mr-[6px] text-grey-40" />
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
                        {selectedPrivateFolderPath && (
                          <button
                            onClick={() => setStopSyncTarget("private")}
                            className="h-10 border border-grey-80 p-1.5 sm:px-3 sm:py-1.5 rounded text-base font-medium bg-grey-100 hover:bg-grey-90 text-grey-10 hover:text-grey-20 transition"
                          >
                            Stop Syncing
                          </button>
                        )}
                        <CardButton
                          className="max-w-[160px] h-10"
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

            <StopSyncDialog
              open={stopSyncTarget !== null}
              onClose={() => setStopSyncTarget(null)}
              onConfirm={handleStopSyncConfirm}
              folderName={selectedPrivateFolderName}
              folderPath={selectedPrivateFolderPath}
              loading={isStoppingSync}
            />
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
        />
      )}
    </>
  );
};

export default UpdateSyncFolder;
