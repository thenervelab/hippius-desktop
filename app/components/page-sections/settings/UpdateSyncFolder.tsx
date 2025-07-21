import React, { useState, useEffect } from "react";
import { InView } from "react-intersection-observer";
import SectionHeader from "./SectionHeader";
import SyncFolderSelector from "../files/ipfs/SyncFolderSelector";
import { getPrivateSyncPath, getPublicSyncPath, setPrivateSyncPath, setPublicSyncPath } from "@/app/lib/utils/syncPathUtils";
import { CardButton, Icons, RevealTextLine } from "../../ui";
import { toast } from "sonner";

const UpdateSyncFolder: React.FC = () => {
    const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] = useState("");
    const [selectedPrivateFolderName, setSelectedPrivateFolderName] = useState("");
    const [selectedPublicFolderPath, setSelectedPublicFolderPath] = useState("");
    const [selectedPublicFolderName, setSelectedPublicFolderName] = useState("");
    const [isPublicFolderSelection, setIsPublicFolderSelection] = useState(false);

    const [showSelector, setShowSelector] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const privatefolderPath = await getPrivateSyncPath();
                const publicfolderPath = await getPublicSyncPath();
                setSelectedPrivateFolderPath(privatefolderPath);
                setSelectedPrivateFolderName(privatefolderPath.split(/[\\/]/).pop() || "");
                setSelectedPublicFolderPath(publicfolderPath);
                setSelectedPublicFolderName(publicfolderPath.split(/[\\/]/).pop() || "");
            } catch {
                console.error("Failed to load sync folder");
            }
        })();
    }, []);

    const handlePrivateFolderSelected = async (p: string) => {
        try {
            console.log("handlePrivateFolderSelected", p)
            await setPrivateSyncPath(p);
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
            console.log("handlePublicFolderSelected", p)
            await setPublicSyncPath(p);
            setSelectedPublicFolderPath(p);
            setSelectedPublicFolderName(p.split(/[\\/]/).pop() || "");
            toast.success("Public sync folder updated");
            setShowSelector(false);

        } catch {
            toast.error("Failed to update public sync folder");
            setShowSelector(false);
        }
    };

    const openFolderSelection = (isPublic: boolean) => {
        setIsPublicFolderSelection(isPublic);
        setShowSelector(true);
    };

    return (
        <InView triggerOnce>
            {({ inView, ref }) => (
                <div ref={ref} className="flex flex-col w-full">
                    {showSelector ? (
                        <SyncFolderSelector
                            initialPath={isPublicFolderSelection ? selectedPublicFolderPath : selectedPrivateFolderPath}
                            isFromSettingsPage
                            onFolderSelected={(path) => (isPublicFolderSelection ? handlePublicFolderSelected(path) : handlePrivateFolderSelected(path))}
                        />
                    ) : (
                        <RevealTextLine rotate reveal={inView} className="delay-300 w-full">
                            <div className="flex flex-col w-full border border-grey-80 rounded-lg p-4">
                                <SectionHeader
                                    Icon={Icons.File2}
                                    title="Change your sync folder"
                                    subtitle="Choose folders to keep your files in sync with Hippius. If you edit or remove files, those changes will be automatically synced."
                                />
                                <div className="flex justify-between p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80">
                                    {selectedPrivateFolderName ? (<div className="flex-1">
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
                                    </div>) : (
                                        <div className="flex items-center text-sm text-grey-60">
                                            No private sync folder set. You can set a private sync folder to sync your files securely.
                                        </div>
                                    )}
                                    <div className="flex self-start">
                                        <CardButton
                                            className="max-w-[160px] h-[40px]"
                                            variant="primary"
                                            onClick={() => openFolderSelection(false)}
                                        >
                                            <span className="text-base leading-4 font-medium">
                                                {selectedPrivateFolderName ? "Change Folder" : "Select Folder"}
                                            </span>
                                        </CardButton>
                                    </div>
                                </div>
                                <div className="flex justify-between p-4 border bg-grey-100 rounded-lg mt-4 border-grey-80">
                                    {selectedPublicFolderName ? (<div className="flex flex-col">
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
                                    </div>) : (
                                        <div className="flex items-center text-sm text-grey-60">
                                            No public sync folder set. You can set a public sync folder to share files with others.
                                        </div>
                                    )}
                                    <div className="flex self-start">
                                        <CardButton
                                            className="max-w-[160px] h-[40px]"
                                            variant="primary"
                                            onClick={() => openFolderSelection(true)}
                                        >
                                            <span className="text-base leading-4 font-medium">
                                                {selectedPrivateFolderName ? "Change Folder" : "Select Folder"}
                                            </span>
                                        </CardButton>
                                    </div>
                                </div>

                                {/* <div className="flex gap-4 mt-8 self-start">
                                    <CardButton
                                        className="max-w-[160px] h-[60px]"
                                        variant="primary"
                                        onClick={() => setShowSelector(true)}
                                    >
                                        <span className="text-lg leading-6 font-medium">
                                            {selectedPrivateFolderName ? "Change Folder" : "Select Folder"}
                                        </span>
                                    </CardButton>
                                </div> */}
                            </div>
                        </RevealTextLine>
                    )}
                </div>
            )}
        </InView>
    );
};

export default UpdateSyncFolder;
