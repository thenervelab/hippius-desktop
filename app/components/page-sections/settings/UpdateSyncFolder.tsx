import React, { useState, useEffect } from "react";
import { InView } from "react-intersection-observer";
import SectionHeader from "./SectionHeader";
import SyncFolderSelector from "../files/ipfs/SyncFolderSelector";
import { getSyncPath, setSyncPath } from "@/app/lib/utils/syncPathUtils";
import { CardButton, Icons, RevealTextLine } from "../../ui";
import { toast } from "sonner";

const UpdateSyncFolder: React.FC = () => {
    const [selectedFolderPath, setSelectedFolderPath] = useState("");
    const [selectedFolderName, setSelectedFolderName] = useState("");
    const [showSelector, setShowSelector] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const p = await getSyncPath();
                setSelectedFolderPath(p);
                setSelectedFolderName(p.split(/[\\/]/).pop() || "");
            } catch {
                console.error("Failed to load sync folder");
            }
        })();
    }, []);

    const handleFolderSelected = async (p: string) => {
        try {
            await setSyncPath(p);
            setSelectedFolderPath(p);
            setSelectedFolderName(p.split(/[\\/]/).pop() || "");
            toast.success("Sync folder updated");
            setShowSelector(false);
        } catch {
            toast.error("Failed to update sync folder");
        }
    };

    return (
        <InView triggerOnce>
            {({ inView, ref }) => (
                <div ref={ref} className="flex flex-col w-full">
                    {showSelector ? (
                        <SyncFolderSelector
                            initialPath={selectedFolderPath}
                            isFromSettingsPage
                            onFolderSelected={handleFolderSelected}
                        />
                    ) : (
                        <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
                            <div className="flex flex-col w-full border border-grey-80 rounded-lg p-4">
                                <SectionHeader
                                    Icon={Icons.File2}
                                    title="Change your sync folder"
                                    subtitle="Choose a different folder to keep your files in sync with Hippius. If you edit or remove files, those changes will be automatically synced."
                                />
                                {selectedFolderName && <div className="flex p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80">
                                    <div className="flex-1">
                                        <div className="flex">
                                            <Icons.Folder className="size-4 mr-[6px] text-grey-40" />
                                            <span className="font-medium text-base text-grey-40 -mt-0.5">
                                                {selectedFolderName}
                                            </span>
                                        </div>
                                        <p className="text-sm text-grey-60 mt-1 ml-6">
                                            {selectedFolderPath}
                                        </p>
                                    </div>
                                </div>
                                }
                                <div className="flex gap-4 mt-8 self-start">
                                    <CardButton
                                        className="max-w-[160px] h-[60px]"
                                        variant="dialog"
                                        onClick={() => setShowSelector(true)}
                                    >
                                        <span className="text-lg leading-6 font-medium">
                                            {selectedFolderName ? "Change Folder" : "Select Folder"}
                                        </span>
                                    </CardButton>
                                </div>
                            </div>
                        </RevealTextLine>
                    )}
                </div>
            )}
        </InView>
    );
};

export default UpdateSyncFolder;
