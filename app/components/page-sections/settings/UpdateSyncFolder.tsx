import React, { useState, useEffect } from "react";
import { InView } from "react-intersection-observer";
import SectionHeader from "./SectionHeader";
import SyncFolderSelector from "@/app/components/page-sections/files/SyncFolderSelector";
import {
  getPrivateSyncPath,
  setPrivateSyncPath
} from "@/app/lib/utils/syncPathUtils";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import StopSyncDialog, { type SyncType } from "./StopSyncDialog";
import { useSetAtom } from "jotai";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";

const UpdateSyncFolder: React.FC = () => {
  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] =
    useState("");
  const [selectedPrivateFolderName, setSelectedPrivateFolderName] =
    useState("");
  const { polkadotAddress, oauthSession } = useWalletAuth();
  const [showSelector, setShowSelector] = useState(false);
  const [stopSyncTarget, setStopSyncTarget] = useState<SyncType | null>(null);
  const [isStoppingSync, setIsStoppingSync] = useState(false);
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);

  useEffect(() => {
    (async () => {
      try {
        const privatefolderPath = await getPrivateSyncPath();
        setSelectedPrivateFolderPath(privatefolderPath);
        setSelectedPrivateFolderName(
          privatefolderPath.split(/[\\/]/).pop() || ""
        );
      } catch {
        console.error("Failed to load sync folder");
      }
    })();
  }, []);

  const handlePrivateFolderSelected = async (p: string) => {
    try {
      console.log("handlePrivateFolderSelected", p);
      if (!p) {
        toast.error("Please select a valid folder for private sync");
        return;
      }
      if (!polkadotAddress) {
        toast.error("Wallet authentication is required");
        return;
      }

      await setPrivateSyncPath(p, polkadotAddress, oauthSession?.token);
      setSelectedPrivateFolderPath(p);
      setSelectedPrivateFolderName(p.split(/[\\/]/).pop() || "");
      toast.success("Private sync folder updated, syncing is now in progress.");
      setShowSelector(false);
      // Trigger files page refresh
      triggerSyncPathRefresh((prev) => prev + 1);
    } catch {
      toast.error("Failed to update private sync folder");
    }
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
      await setPrivateSyncPath("", polkadotAddress, oauthSession?.token);
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
                  />
                  <div className="flex justify-between p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80 w-full">
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
                        onClick={() => setShowSelector(true)}
                      >
                        <span className="text-base leading-4 font-medium">
                          {selectedPrivateFolderName
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
  );
};

export default UpdateSyncFolder;
