import React from 'react';
import { Button } from '@/components/ui/button/NewButton';
import { useFileSelection } from '@/app/contexts/FileSelectionContext';
import { FormattedUserIpfsFile } from '@/lib/hooks/use-user-ipfs-files';
import * as Dialog from '@radix-ui/react-dialog';
import { X, AlertTriangle } from 'lucide-react';

interface DeleteConfirmationDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (filesToDelete: FormattedUserIpfsFile[]) => void;
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
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
                <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-lg p-6 w-full max-w-md z-50">
                    <div className="flex items-start gap-4">
                        <div className="flex-shrink-0 w-12 h-12 rounded-full bg-red-100 flex items-center justify-center">
                            <AlertTriangle className="w-6 h-6 text-red-600" />
                        </div>

                        <div className="flex-1">
                            <Dialog.Title className="text-lg font-semibold text-gray-900 mb-2">
                                Delete {isMultiple ? 'Files' : 'File'}
                            </Dialog.Title>

                            <Dialog.Description className="text-sm text-gray-600 mb-4">
                                Are you sure you want to delete {isMultiple ? `these ${fileCount} files` : 'this file'}?
                                {' '}This action cannot be undone.
                            </Dialog.Description>

                            {selectedFiles.length > 0 && (
                                <div className="mb-4 max-h-32 overflow-y-auto">
                                    <div className="text-xs text-gray-500 mb-1">Files to delete:</div>
                                    <ul className="text-sm space-y-1">
                                        {selectedFiles.slice(0, 5).map((file) => (
                                            <li key={file.cid} className="text-gray-700 truncate">
                                                • {file.actualFileName || file.name}
                                            </li>
                                        ))}
                                        {selectedFiles.length > 5 && (
                                            <li className="text-gray-500 text-xs">
                                                ... and {selectedFiles.length - 5} more
                                            </li>
                                        )}
                                    </ul>
                                </div>
                            )}
                        </div>

                        <Dialog.Close asChild>
                            <button
                                className="text-gray-400 hover:text-gray-600 transition-colors"
                                aria-label="Close"
                                onClick={() => onOpenChange(false)}
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </Dialog.Close>
                    </div>

                    <div className="flex justify-end gap-3 mt-6">
                        <Button
                            variant="outline"
                            onClick={handleCancel}
                            disabled={isLoading}
                            className="border-gray-300 text-gray-700 hover:bg-gray-50"
                        >
                            Cancel
                        </Button>

                        <Button
                            variant="destructive"
                            onClick={handleConfirm}
                            disabled={isLoading}
                            className="bg-red-600 hover:bg-red-700 text-white"
                        >
                            {isLoading ? 'Deleting...' : `Delete ${isMultiple ? 'Files' : 'File'}`}
                        </Button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
};

export default DeleteConfirmationDialog;