import * as Dialog from "@radix-ui/react-dialog";
import React from "react";
import { ArrowLeft } from "lucide-react";
import DialogContainer from "@/components/ui/DialogContainer";
import { CardButton, Graphsheet, Icons } from "@/components/ui";

export interface ArchiveAllConfirmationProps {
    open: boolean;
    onClose: () => void;
    onConfirm: () => void;
    loading?: boolean;
}

const ArchiveAllConfirmationDialog: React.FC<ArchiveAllConfirmationProps> = ({
    open,
    onClose,
    onConfirm,
    loading = false
}) => {
    return (
        <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
            <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
                <Dialog.Title className="sr-only">Delete All Notifications</Dialog.Title>

                {/* Top accent bar (mobile only) */}
                <div className="h-4 bg-primary-50 md:hidden block" />

                <div className="px-4">
                    {/* Desktop Header */}
                    <div className="text-2xl font-medium text-grey-10 hidden md:flex flex-col items-center justify-center pb-2 pt-4 gap-4">
                        <div className="size-14 flex justify-center items-center relative">
                            <Graphsheet
                                majorCell={{
                                    lineColor: [31, 80, 189, 1.0],
                                    lineWidth: 2,
                                    cellDim: 200
                                }}
                                minorCell={{
                                    lineColor: [49, 103, 211, 1.0],
                                    lineWidth: 1,
                                    cellDim: 20
                                }}
                                className="absolute w-full h-full duration-500 opacity-30 z-0"
                            />
                            <div className="bg-white-cloud-gradient-sm absolute w-full h-full z-10" />
                            <div className="h-8 w-8 bg-error-50 rounded-lg flex items-center justify-center z-20">
                                <Icons.Trash className="size-6 text-grey-100" />
                            </div>
                        </div>
                        <span className="text-center text-2xl text-grey-10 font-medium">
                            Delete all notifications?
                        </span>
                    </div>

                    {/* Mobile Header */}
                    <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
                        <button onClick={onClose} className="mr-2">
                            <ArrowLeft className="size-6 text-grey-10" />
                        </button>
                        <div className="text-lg font-medium relative">
                            <span className="capitalize">Delete All Notifications</span>
                        </div>
                        <button onClick={onClose}>
                            <Icons.CloseCircle className="size-6 relative" />
                        </button>
                    </div>

                    {/* Message */}
                    <div className="font-medium text-base text-grey-20 mb-4 text-center">
                        This will permanently remove all notifications from your history.
                        This action cannot be undone.
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-4 mb-6">
                        <CardButton
                            className="text-base w-full"
                            variant="error"
                            onClick={onConfirm}
                            disabled={loading}
                            loading={loading}
                        >
                            {loading ? "Deleting..." : "Delete All"}
                        </CardButton>

                        <CardButton
                            className="w-full"
                            variant="secondary"
                            onClick={onClose}
                            disabled={loading}
                        >
                            Cancel
                        </CardButton>
                    </div>
                </div>
            </DialogContainer>
        </Dialog.Root>
    );
};

export default ArchiveAllConfirmationDialog;
