import React, { useState, useEffect } from "react";
import { InView } from "react-intersection-observer";
import SectionHeader from "./SectionHeader";
import SyncFolderSelector from "@/components/page-sections/files/ipfs/SyncFolderSelector";
import {
  getPrivateSyncPath,
  getPublicSyncPath,
  setPrivateSyncPath,
  setPublicSyncPath
} from "@/app/lib/utils/syncPathUtils";
import { CardButton, Icons, RevealTextLine } from "@/components/ui";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";


const UpdateSyncFolder: React.FC = () => {
  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] =
    useState("");
  const [selectedPrivateFolderName, setSelectedPrivateFolderName] =
    useState("");
  const [selectedPublicFolderPath, setSelectedPublicFolderPath] = useState("");
  const [selectedPublicFolderName, setSelectedPublicFolderName] = useState("");
  const [isPublicFolderSelection, setIsPublicFolderSelection] = useState(false);
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const [showSelector, setShowSelector] = useState(false);

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

  useEffect(() => {
    (async () => {
      try {
        const publicfolderPath = await getPublicSyncPath();
        setSelectedPublicFolderPath(publicfolderPath);
        setSelectedPublicFolderName(
          publicfolderPath.split(/[\\/]/).pop() || ""
        );
      } catch {
        console.error("Failed to load sync folder");
      }
    })();
  }, []);

  const handlePrivateFolderSelected = async (p: string) => {
    try {
      console.log("handlePrivateFolderSelected", p);
      if (p === selectedPublicFolderPath) {
        toast.error("Private sync folder cannot be the same as public sync folder");
        return;
      }
      if (!p) {
        toast.error("Please select a valid folder for private sync");
        return;
      }
      await setPrivateSyncPath(p, polkadotAddress, mnemonic);
      setSelectedPrivateFolderPath(p);
      setSelectedPrivateFolderName(p.split(/[\\/]/).pop() || "");
      toast.success("Private sync folder updated");
      setShowSelector(false);
    } catch {
      toast.error("Failed to update private sync folder");
    }
  };

  const handlePublicFolderSelected = async (p: string) => {
    try {
      console.log("handlePublicFolderSelected", p);
      if (p === selectedPrivateFolderPath) {
        toast.error("Public sync folder cannot be the same as private sync folder");
        return;
      }
      if (!p) {
        toast.error("Please select a valid folder for public sync");
        return;
      }
      await setPublicSyncPath(p, polkadotAddress, mnemonic);
      setSelectedPublicFolderPath(p);
      setSelectedPublicFolderName(p.split(/[\\/]/).pop() || "");
      toast.success("Public sync folder updated");
      setShowSelector(false);
    } catch {
      toast.error("Failed to update public sync folder");
    }
  };

  const openFolderSelection = (isPublic: boolean) => {
    setIsPublicFolderSelection(isPublic);
    setShowSelector(true);
  };

  const handleBackClick = () => {
    setShowSelector(false);
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
                    subtitle="Choose folders to keep your files in sync with Hippius. If you edit or remove files, those changes will be automatically synced."
                    info="Sync folders connect your local storage with our decentralized network, providing both convenience and blockchain-backed security for your files."
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
                    <div className="flex self-start">
                      <CardButton
                        className="max-w-[160px] h-[40px]"
                        variant="primary"
                        onClick={() => openFolderSelection(false)}
                      >
                        <span className="text-base leading-4 font-medium">
                          {selectedPrivateFolderName
                            ? "Change Folder"
                            : "Select Folder"}
                        </span>
                      </CardButton>
                    </div>
                  </div>
                  <div className="flex justify-between p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80">
                    {selectedPublicFolderName ? (
                      <div className="flex flex-col">
                        <div className="flex">
                          <Icons.Folder className="size-4 mr-[6px] text-grey-40" />
                          <span className="font-medium text-base text-grey-40 -mt-0.5">
                            {selectedPublicFolderName}
                          </span>
                          <div className="-mt-1 ml-4 px-2 py-1 text-xs rounded bg-success-80 text-success-40 font-medium border border-grey-80">
                            Public
                          </div>
                        </div>

                        <p className="text-sm text-grey-60 mt-1 ml-6">
                          {selectedPublicFolderPath}
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-center text-sm text-grey-60">
                        No public sync folder set. You can set a public sync
                        folder to share files with others.
                      </div>
                    )}
                    <div className="flex self-start">
                      <CardButton
                        className="max-w-[160px] h-[40px]"
                        variant="primary"
                        onClick={() => openFolderSelection(true)}
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
                  initialPath={
                    isPublicFolderSelection
                      ? selectedPublicFolderPath
                      : selectedPrivateFolderPath
                  }
                  handleBackClick={handleBackClick}
                  isFromSettingsPage
                  onFolderSelected={(path) =>
                    isPublicFolderSelection
                      ? handlePublicFolderSelected(path)
                      : handlePrivateFolderSelected(path)
                  }
                />
              </RevealTextLine>
            </div>
          </div>
        </div>
      )}
    </InView>
  );
};

export default UpdateSyncFolder;
