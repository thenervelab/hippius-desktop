import React from "react";
import * as Dialog from "@radix-ui/react-dialog";

import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";

type SyncType = "private";

export interface StopSyncDialogProps {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    folderName?: string;
    folderPath?: string;
    loading?: boolean;
}

const StopSyncDialog: React.FC<StopSyncDialogProps> = ({
    open,
    onClose,
    onConfirm,
    folderName,
    folderPath,
    loading = false,
}) => {
    const heading = "Stop syncing this folder?";

    const description =
        "We'll stop syncing files between Hippius and this folder. Your local files stay on your computer, and any files already uploaded remain safely in Hippius.";

    return (
        <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && !loading && onClose()}>
            <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[26.75rem] h-fit" preventClose={loading}>
                <Dialog.Title className="sr-only">Stop folder sync</Dialog.Title>

                <div className="px-4 py-6 flex flex-col gap-5">
                    <div className="flex flex-col items-center text-center gap-3">
                        <div className="size-14 flex justify-center items-center relative">
                            <Graphsheet
                                majorCell={{
                                    lineColor: [31, 80, 189, 1.0],
                                    lineWidth: 2,
                                    cellDim: 200,
                                }}
                                minorCell={{
                                    lineColor: [49, 103, 211, 1.0],
                                    lineWidth: 1,
                                    cellDim: 20,
                                }}
                                className="absolute w-full h-full duration-500 opacity-30 z-0"
                            />
                            <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
                            <div className="h-8 w-8 bg-primary-50 rounded-lg flex items-center justify-center z-20">
                                <Icons.HippiusLogo className="size-6 text-grey-100" />
                            </div>
                        </div>
                        <h2 className="text-xl font-semibold text-grey-10">{heading}</h2>
                        <p className="text-sm text-grey-50 max-w-sm">{description}</p>
                        {folderName && (
                            <div className="text-sm text-grey-30 font-medium">
                                Folder: <span className="text-grey-10">{folderName}</span>
                            </div>
                        )}
                        {folderPath && (
                            <div className="text-xs text-grey-50 max-w-sm break-all">
                                {folderPath}
                            </div>
                        )}
                    </div>

                    <div className="bg-primary-95 border border-primary-80 rounded-lg p-3 text-xs text-primary-40 text-left">
                        You can choose a different folder anytime. Sync will pause for this path until you set a new one.
                    </div>

                    <div className="flex gap-3">
                        <CardButton
                            className="w-full"
                            variant="secondary"
                            onClick={onClose}
                            disabled={loading}
                        >
                            Keep syncing
                        </CardButton>
                        <CardButton
                            className="w-full"
                            variant="error"
                            onClick={onConfirm}
                            disabled={loading}
                            loading={loading}
                        >
                            {loading ? "Stopping..." : "Stop syncing"}
                        </CardButton>
                    </div>
                </div>
            </DialogContainer>
        </Dialog.Root>
    );
};

export default StopSyncDialog;
export type { SyncType };
