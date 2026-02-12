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
import { cn } from "@/lib/utils";
import { uploadToIpfsAndSubmitToBlockcahinRequestStateAtom } from "@/app/components/page-sections/files/atoms/query-atoms";
import { useAtomValue } from "jotai";
import FolderFileUploadFlow from "./folder-file-upload-flow";

const HIPPIUS_DROP_EVENT = "hippius:folder-file-drop";

export interface AddFileToFolderButtonProps {
    className?: string;
    folderName: string;
    isPrivateFolder: boolean;
    /** Relative path from sync root to the current folder. */
    subfolder?: string;
    onFileAdded: () => void;
    disabled?: boolean;
}

export interface AddFileToFolderButtonRef {
    openWithFiles: (files: FileList) => void;
    openWithPaths: (paths: string[]) => void;
    isDialogOpen: () => boolean;
}

const AddFileToFolderButton = forwardRef<AddFileToFolderButtonRef, AddFileToFolderButtonProps>(
    ({ className, folderName, isPrivateFolder, subfolder, onFileAdded, disabled: externalDisabled }, ref) => {
        const [isOpen, setIsOpen] = useState(false);
        const [droppedFiles, setDroppedFiles] = useState<FileList | null>(null);
        const [droppedPaths, setDroppedPaths] = useState<string[] | null>(null);

        const uploadingState = useAtomValue(
            uploadToIpfsAndSubmitToBlockcahinRequestStateAtom
        );
        const isLoading = uploadingState !== "idle";

        useImperativeHandle(
            ref,
            () => ({
                openWithFiles: (files: FileList) => {
                    setDroppedPaths(null);
                    setDroppedFiles(files);
                    setIsOpen(true);
                },
                openWithPaths: (paths: string[]) => {
                    setDroppedFiles(null);
                    setDroppedPaths(paths);
                    setIsOpen(true);
                },
                isDialogOpen: () => isOpen
            }),
            [isOpen]
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
            <FolderFileUploadFlow
                folderName={folderName}
                isPrivateFolder={isPrivateFolder}
                subfolder={subfolder}
                initialFiles={droppedFiles}
                initialPaths={droppedPaths}
                onSuccess={handleSuccess}
                onCancel={closeDialog}
            />
        ), [folderName, isPrivateFolder, subfolder, droppedFiles, droppedPaths, handleSuccess, closeDialog]);

        return (
            <>
                <CardButton
                    className={cn("h-10 w-fit p-1", externalDisabled && "opacity-50 cursor-not-allowed", className)}
                    onClick={() => setIsOpen(true)}
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
                            <Dialog.Content className="border shadow-dialog bg-white flex flex-col max-w-[428px] border-grey-80 bg-background-1 rounded-[8px] overflow-hidden w-full relative data-[state=open]:animate-scale-in-95-0.2">
                                <Dialog.Title className="hidden">Add File to {folderName}</Dialog.Title>

                                <div className="flex p-4 items-center text-grey-10 relative">
                                    <div className="lg:text-xl flex w-full 2xl:text-2xl font-medium relative">
                                        <span className="capitalize">Add File to {folderName}</span>
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
