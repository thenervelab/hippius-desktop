import React from 'react';
import { useFileSelection } from '@/app/contexts/FileSelectionContext';
import { FormattedUserFile } from '@/app/lib/hooks/use-user-files';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft } from 'lucide-react';
import DialogContainer from '@/components/ui/DialogContainer';
import { CardButton, Graphsheet, Icons } from '@/components/ui';

interface DeleteConfirmationDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (filesToDelete: FormattedUserFile[]) => void;
    isLoading?: boolean;
}

const DeleteConfirmationDialog: React.FC<DeleteConfirmationDialogProps> = ({
    open,
    onOpenChange,
    onConfirm,
    isLoading = false
}) => {
    const { selectedFiles, clearSelection } = useFileSelection();

    const handleCancel = () => {
        onOpenChange(false);
        clearSelection();
    };

    const handleConfirm = () => {
        console.log("Delete confirmation - files being deleted:", selectedFiles.map(f => ({ name: f.name, actualFileName: f.actualFileName })));

        // Capture the files before clearing selection
        const filesToDelete = [...selectedFiles];

        // Clear selection immediately for good UX
        clearSelection();
        onOpenChange(false);

        // Pass the captured files to the delete operation
        onConfirm(filesToDelete);
    };

    const fileCount = selectedFiles.length;
    const isMultiple = fileCount > 1;

    return (
        <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && handleCancel()}>
            <DialogContainer className="md:inset-0 md:m-auto md:w-[90vw] md:max-w-[428px] h-fit">
                <Dialog.Title className="sr-only">Delete {isMultiple ? 'Files' : 'File'}</Dialog.Title>

                {/* Top accent bar (mobile only) */}
                <div className="h-4 bg-error-50 md:hidden block" />

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
                            Delete {isMultiple ? 'files' : 'file'}?
                        </span>
                    </div>

                    {/* Mobile Header */}
                    <div className="flex py-4 items-center justify-between text-grey-10 relative w-full md:hidden">
                        <button onClick={handleCancel} className="mr-2">
                            <ArrowLeft className="size-6 text-grey-10" />
                        </button>
                        <div className="text-lg font-medium relative">
                            <span className="capitalize">Delete {isMultiple ? 'Files' : 'File'}</span>
                        </div>
                        <button onClick={handleCancel}>
                            <Icons.CloseCircle className="size-6 relative" />
                        </button>
                    </div>

                    {/* Message */}
                    <div className="font-medium text-base text-grey-20 mb-4">
                        Are you sure you want to delete {isMultiple ? `these ${fileCount} files` : 'this file'}?
                        This action cannot be undone.
                    </div>

                    {selectedFiles.length > 0 && (
                        <div className="mb-4 max-h-32 overflow-y-auto">
                            <div className="text-xs text-grey-50 mb-2">Files to delete:</div>
                            <ul className="text-sm space-y-1">
                                {selectedFiles.slice(0, 5).map((file) => (
                                    <li key={file.cid} className="text-grey-20 truncate">
                                        • {file.actualFileName || file.name}
                                    </li>
                                ))}
                                {selectedFiles.length > 5 && (
                                    <li className="text-grey-50 text-xs">
                                        ... and {selectedFiles.length - 5} more
                                    </li>
                                )}
                            </ul>
                        </div>
                    )}

                    {/* Action Buttons */}
                    <div className="flex gap-4 mb-6">
                        <CardButton
                            className="text-base w-full"
                            variant="error"
                            onClick={handleConfirm}
                            disabled={isLoading}
                            loading={isLoading}
                        >
                            {isLoading ? 'Deleting...' : `Delete ${isMultiple ? 'Files' : 'File'}`}
                        </CardButton>

                        <CardButton
                            className="w-full"
                            variant="secondary"
                            onClick={handleCancel}
                            disabled={isLoading}
                        >
                            Cancel
                        </CardButton>
                    </div>
                </div>
            </DialogContainer>
        </Dialog.Root>
    );
};

export default DeleteConfirmationDialog;