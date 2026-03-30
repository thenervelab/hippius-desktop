import { CardButton } from "@/components/ui";
import { PlusCircle, Loader2 } from "lucide-react";
import {
    useState,
    useMemo,
    forwardRef,
    useImperativeHandle,
    useCallback,
    useEffect
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Icons } from "@/components/ui";
import PrivacyBadge from "@/components/ui/PrivacyBadge";
import { cn } from "@/lib/utils";
import { uploadToIpfsAndSubmitToBlockcahinRequestStateAtom } from "@/app/components/page-sections/files/atoms/query-atoms";
import { useAtomValue } from "jotai";
import UploadFilesFlow from "./upload-files-flow";
import { syncEngineStatusAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { toast } from "sonner";

const HIPPIUS_DROP_EVENT = "hippius:folder-file-drop";

export interface AddFileToFolderButtonProps {
    className?: string;
    folderName: string;
    /** Relative path from sync root to the current folder. */
    subfolder?: string;
    onFileAdded: () => void;
    disabled?: boolean;
    /** Resolved sync root path for this folder (from FolderView). */
    syncBasePath?: string;
}

export interface AddFileToFolderButtonRef {
    openWithFiles: (files: FileList) => void;
    openWithPaths: (paths: string[]) => void;
    isDialogOpen: () => boolean;
}

const AddFileToFolderButton = forwardRef<AddFileToFolderButtonRef, AddFileToFolderButtonProps>(
    ({ className, folderName, subfolder, onFileAdded, disabled: externalDisabled, syncBasePath }, ref) => {
        const [isOpen, setIsOpen] = useState(false);
        const [droppedFiles, setDroppedFiles] = useState<FileList | null>(null);
        const [droppedPaths, setDroppedPaths] = useState<string[] | null>(null);

        const uploadingState = useAtomValue(
            uploadToIpfsAndSubmitToBlockcahinRequestStateAtom
        );
        const isLoading = uploadingState !== "idle";
        const syncEngineStatus = useAtomValue(syncEngineStatusAtom);

        useImperativeHandle(
            ref,
            () => ({
                openWithFiles: (files: FileList) => {
                    if (syncEngineStatus === "stopped") {
                        toast.warning("Syncing is stopped. Resume syncing from Settings \u2192 Sync & Storage before adding files.");
                        return;
                    }
                    setDroppedPaths(null);
                    setDroppedFiles(files);
                    setIsOpen(true);
                },
                openWithPaths: (paths: string[]) => {
                    if (syncEngineStatus === "stopped") {
                        toast.warning("Syncing is stopped. Resume syncing from Settings \u2192 Sync & Storage before adding files.");
                        return;
                    }
                    setDroppedFiles(null);
                    setDroppedPaths(paths);
                    setIsOpen(true);
                },
                isDialogOpen: () => isOpen
            }),
            [isOpen, syncEngineStatus]
        );

        const closeDialog = useCallback(() => {
            setIsOpen(false);
            setDroppedFiles(null);
            setDroppedPaths(null);
        }, []);

        const handleSuccess = useCallback(() => {
            closeDialog();
            onFileAdded();
        }, [closeDialog, onFileAdded]);

        useEffect(() => {
            const handleDroppedFiles = (event: Event) => {
                const customEvent = event as CustomEvent;
                if (customEvent.detail?.files && !isOpen) {
                    setDroppedFiles(customEvent.detail.files);
                    setIsOpen(true);
                }
            };

            window.addEventListener(HIPPIUS_DROP_EVENT, handleDroppedFiles);
            return () => {
                window.removeEventListener(HIPPIUS_DROP_EVENT, handleDroppedFiles);
            };
        }, [isOpen]);

        const dialogContent = useMemo(() => (
            <UploadFilesFlow
                mode="folder"
                folderName={folderName}
                subfolder={subfolder}
                syncBasePath={syncBasePath}
                initialFiles={droppedFiles}
                initialPaths={droppedPaths}
                onSuccess={handleSuccess}
                onCancel={closeDialog}
            />
        ), [folderName, subfolder, syncBasePath, droppedFiles, droppedPaths, handleSuccess, closeDialog]);

        return (
            <>
                <CardButton
                    className={cn("h-10 w-fit p-1", externalDisabled && "opacity-50 cursor-not-allowed", className)}
                    onClick={() => {
                        if (syncEngineStatus === "stopped") {
                            toast.warning("Syncing is stopped. Resume syncing from Settings \u2192 Sync & Storage before adding files.");
                            return;
                        }
                        setIsOpen(true);
                    }}
                    disabled={isLoading || externalDisabled}
                >
                    <div className="flex items-center gap-2 text-grey-100 text-base font-medium p-2">
                        <div>
                            <PlusCircle className="size-4" />
                        </div>
                        <span className="flex items-center">
                            {isLoading ? (
                                <Loader2 className="animate-spin size-4" />
                            ) : (
                                "Add File"
                            )}
                        </span>
                    </div>
                </CardButton>

                <Dialog.Root
                    open={isOpen}
                    onOpenChange={(open) => {
                        if (!open) closeDialog();
                        else setIsOpen(true);
                    }}
                >
                    <Dialog.Portal>
                        <Dialog.Overlay className="bg-white/70 fixed p-4 z-30 top-0 w-full h-full flex items-center justify-center data-[state=open]:animate-fade-in-0.3">
                            <Dialog.Content className="border shadow-dialog bg-white flex flex-col max-w-[26.75rem] border-grey-80 bg-background-1 rounded-[0.5rem] overflow-hidden w-full relative data-[state=open]:animate-scale-in-95-0.2">
                                <Dialog.Title className="hidden">Add File</Dialog.Title>

                                <div className="flex p-4 items-center text-grey-10 relative">
                                    <div className="lg:text-xl flex w-full items-center gap-2 2xl:text-2xl font-medium relative">
                                        <span className="capitalize">Add File</span>
                                        <PrivacyBadge variant="file" />
                                    </div>
                                    <button
                                        type="button"
                                        className="ml-auto"
                                        onClick={closeDialog}
                                    >
                                        <Icons.CloseCircle
                                            className="size-6 relative"
                                            strokeWidth={2.5}
                                        />
                                    </button>
                                </div>

                                <div className="grow max-h-[calc(85vh-120px)] p-4 pt-2 overflow-y-auto">
                                    {dialogContent}
                                </div>
                            </Dialog.Content>
                        </Dialog.Overlay>
                    </Dialog.Portal>
                </Dialog.Root>
            </>
        );
    }
);

AddFileToFolderButton.displayName = "AddFileToFolderButton";

export default AddFileToFolderButton;
