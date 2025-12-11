import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button/NewButton';
import { useFileSelection } from '@/app/contexts/FileSelectionContext';
import { FormattedUserFile } from '@/app/lib/hooks/use-user-files';
import { Trash2 } from 'lucide-react';
import DeleteConfirmationDialog from './DeleteConfirmationDialog';

interface SelectionActionBarProps {
    onDelete: (files: FormattedUserFile[]) => void;
    isDeleting?: boolean;
}

const SelectionActionBar: React.FC<SelectionActionBarProps> = ({ onDelete, isDeleting = false }) => {
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const {
        isSelectionMode,
        selectedFiles,
        clearSelection
    } = useFileSelection();

    // Close dialog when selection is cleared (after successful deletion)
    useEffect(() => {
        if (selectedFiles.length === 0 && showDeleteDialog) {
            setShowDeleteDialog(false);
        }
    }, [selectedFiles.length, showDeleteDialog]);

    if (!isSelectionMode) {
        return null;
    }

    const handleDeleteClick = () => {
        if (selectedFiles.length > 0) {
            setShowDeleteDialog(true);
        }
    };

    const handleConfirmDelete = (filesToDelete: FormattedUserFile[]) => {
        onDelete(filesToDelete);
        // Don't close dialog here - it will close automatically when selection is cleared after successful deletion
    };

    const handleDialogCancel = (open: boolean) => {
        setShowDeleteDialog(open);
        // Don't clear selection when user cancels dialog
    };

    return (
        <>
            <div className="fixed bottom-16 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-lg">
                <div className="bg-primary-50 text-grey-100 rounded-full shadow-lg px-4 py-2 flex items-center justify-between">
                    <div className="font-medium text-sm">
                        {selectedFiles.length} {selectedFiles.length === 1 ? 'file' : 'files'} selected
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={clearSelection}
                            className='hover:!text-grey-90 !text-grey-100'
                            disabled={isDeleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleDeleteClick}
                            disabled={selectedFiles.length === 0 || isDeleting}
                            className="flex items-center gap-1 hover:!text-error-70 !text-grey-100"
                        >
                            <Trash2 className="w-4 h-4" />
                            <span>{isDeleting ? 'Deleting...' : 'Delete'}</span>
                        </Button>
                    </div>
                </div>
            </div>

            <DeleteConfirmationDialog
                open={showDeleteDialog}
                onOpenChange={handleDialogCancel}
                onConfirm={handleConfirmDelete}
                isLoading={isDeleting}
            />
        </>
    );
};

export default SelectionActionBar;