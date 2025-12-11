import React, { useMemo, useCallback } from 'react';
import { Menu } from 'lucide-react';
import FileCheckbox from './files-table/FileCheckbox';
import { useFileSelection } from '@/app/contexts/FileSelectionContext';
import { FormattedUserFile } from '@/app/lib/hooks/use-user-files';

type SelectionColumnProps = {
    row: {
        original: FormattedUserFile;
    };
};

const SelectionColumnComponent: React.FC<SelectionColumnProps> = ({ row }) => {
    const { isSelectionMode, toggleFileSelection, isFileSelected } = useFileSelection();
    const file = row.original;

    if (!isSelectionMode) return null;

    return (
        <div className="flex justify-center items-center h-full checkbox-container">
            <FileCheckbox
                selected={isFileSelected(file)}
                onChange={() => toggleFileSelection(file)}
                disabled={!file.isAssigned}
            />
        </div>
    );
};

export const SelectionColumn = React.memo(SelectionColumnComponent);
SelectionColumn.displayName = 'SelectionColumn';

const SelectionHeaderColumnComponent: React.FC<{
    files: FormattedUserFile[];
}> = ({ files }) => {
    const { isSelectionMode, selectedFiles, selectAllFiles, unselectAllFiles } = useFileSelection();

    // Memoize deletableFiles to prevent infinite re-renders
    const deletableFiles = useMemo(() => {
        return files.filter(file => file.isAssigned);
    }, [files]);

    // Use stable count values and memoize the calculation
    const allSelected = useMemo(() => {
        const deletableCount = deletableFiles.length;
        const selectedCount = selectedFiles.length;
        return deletableCount > 0 && selectedCount === deletableCount;
    }, [deletableFiles.length, selectedFiles.length]);

    const toggleSelectAll = useCallback(() => {
        if (allSelected) {
            unselectAllFiles();
        } else {
            // Only select files that have isAssigned as true
            selectAllFiles(deletableFiles);
        }
    }, [allSelected, unselectAllFiles, selectAllFiles, deletableFiles]);

    if (!isSelectionMode) return null;

    return (
        <div className="flex justify-center items-center h-full checkbox-container">
            <FileCheckbox
                selected={allSelected}
                onChange={toggleSelectAll}
            />
        </div>
    );
};

export const SelectionHeaderColumn = React.memo(SelectionHeaderColumnComponent);
SelectionHeaderColumn.displayName = 'SelectionHeaderColumn';

export const SelectionToggle: React.FC = () => {
    const { toggleSelectionMode, isSelectionMode, selectedFiles } = useFileSelection();

    return (
        <button
            className="p-1 rounded-md hover:bg-gray-100"
            onClick={toggleSelectionMode}
            aria-label={isSelectionMode ? "Exit selection mode" : "Enter selection mode"}
        >
            {isSelectionMode ? (
                <div className="text-xs px-2 py-1 bg-primary-50 text-white rounded-md">
                    {selectedFiles.length} selected
                </div>
            ) : (
                <Menu className="h-5 w-5" />
            )}
        </button>
    );
};

SelectionToggle.displayName = 'SelectionToggle';