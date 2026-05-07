import React from 'react';
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
    const { isSelectionMode, selectedFiles, addFilesToSelection, removeFilesFromSelection } = useFileSelection();

    // Calculate deletable files directly without memo to avoid staleness
    const deletableFiles = files.filter(file => file.isAssigned);

    // Check if all files on the CURRENT PAGE are selected
    const allSelected = deletableFiles.length > 0 && deletableFiles.every(file =>
        selectedFiles.some(selectedFile =>
            selectedFile.actualFileName === file.actualFileName && selectedFile.label === file.label
        )
    );

    // Remove useCallback to prevent stale closure - always use fresh props
    const toggleSelectAll = () => {
        // Get absolutely fresh snapshot at click time
        const currentPageDeletableFiles = files.filter(file => file.isAssigned);

        if (allSelected) {
            removeFilesFromSelection(currentPageDeletableFiles);
        } else {
            addFilesToSelection(currentPageDeletableFiles);
        }
    };

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

// Remove React.memo to ensure component always receives fresh props
export const SelectionHeaderColumn = SelectionHeaderColumnComponent;
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