import React, { createContext, useContext, useState, ReactNode, useMemo, useCallback } from 'react';
import { FormattedUserFile } from '../lib/hooks/use-user-files';

interface FileSelectionContextProps {
    isSelectionMode: boolean;
    selectedFiles: FormattedUserFile[];
    toggleSelectionMode: () => void;
    toggleFileSelection: (file: FormattedUserFile) => void;
    isFileSelected: (file: FormattedUserFile) => boolean;
    clearSelection: () => void;
    selectAllFiles: (files: FormattedUserFile[]) => void;
    unselectAllFiles: () => void;
    enterSelectionModeAndSelectFile: (file: FormattedUserFile) => void;
    addFilesToSelection: (files: FormattedUserFile[]) => void;
    removeFilesFromSelection: (files: FormattedUserFile[]) => void;
}

const FileSelectionContext = createContext<FileSelectionContextProps | undefined>(undefined);

export const useFileSelection = () => {
    const context = useContext(FileSelectionContext);
    if (!context) {
        throw new Error('useFileSelection must be used within a FileSelectionProvider');
    }
    return context;
};

interface FileSelectionProviderProps {
    children: ReactNode;
}

export const FileSelectionProvider: React.FC<FileSelectionProviderProps> = ({ children }) => {
    const [isSelectionMode, setIsSelectionMode] = useState(false);
    const [selectedFiles, setSelectedFiles] = useState<FormattedUserFile[]>([]);

    const toggleSelectionMode = useCallback(() => {
        setIsSelectionMode(prev => {
            if (prev) {
                // Clear selection when exiting selection mode
                setSelectedFiles([]);
            }
            return !prev;
        });
    }, []);

    const toggleFileSelection = useCallback((file: FormattedUserFile) => {
        // Only allow selection of files that can be deleted (isAssigned)
        if (!file.isAssigned) {
            return;
        }

        setSelectedFiles(prevSelected => {
            const isSelected = prevSelected.some(f => f.actualFileName === file.actualFileName);

            if (isSelected) {
                return prevSelected.filter(f => f.actualFileName !== file.actualFileName);
            } else {
                return [...prevSelected, file];
            }
        });
    }, []);

    const isFileSelected = useCallback((file: FormattedUserFile) => {
        return selectedFiles.some(f => f.actualFileName === file.actualFileName);
    }, [selectedFiles]);

    const clearSelection = useCallback(() => {
        setSelectedFiles([]);
        setIsSelectionMode(false); // Exit selection mode when clearing
    }, []);

    const selectAllFiles = useCallback((files: FormattedUserFile[]) => {
        // Filter to only include files that can be deleted (isAssigned)
        const deletableFiles = files.filter(file => file.isAssigned);
        setSelectedFiles(deletableFiles);
    }, []);

    const unselectAllFiles = useCallback(() => {
        setSelectedFiles([]);
    }, []);

    const enterSelectionModeAndSelectFile = useCallback((file: FormattedUserFile) => {
        // Only allow entering selection mode with deletable files
        if (!file.isAssigned) {
            return;
        }

        // Set selection mode and select the file in one atomic operation
        setIsSelectionMode(true);
        setSelectedFiles([file]);
    }, []);

    const addFilesToSelection = useCallback((files: FormattedUserFile[]) => {
        // Only add files that can be deleted (isAssigned)
        const deletableFiles = files.filter(file => file.isAssigned);

        setSelectedFiles(prevSelected => {
            // Create a set of already selected file names for efficient lookup
            const selectedFileNames = new Set(prevSelected.map(f => f.actualFileName));

            // Add only files that aren't already selected
            const newFiles = deletableFiles.filter(file => !selectedFileNames.has(file.actualFileName));

            return [...prevSelected, ...newFiles];
        });
    }, []);

    const removeFilesFromSelection = useCallback((files: FormattedUserFile[]) => {
        setSelectedFiles(prevSelected => {
            // Create a set of file names to remove for efficient lookup
            const fileNamesToRemove = new Set(files.map(f => f.actualFileName));

            // Keep only files that are not in the removal list
            return prevSelected.filter(file => !fileNamesToRemove.has(file.actualFileName));
        });
    }, []);

    // Memoize the context value to prevent unnecessary re-renders
    const contextValue = useMemo(() => ({
        isSelectionMode,
        selectedFiles,
        toggleSelectionMode,
        toggleFileSelection,
        isFileSelected,
        clearSelection,
        selectAllFiles,
        unselectAllFiles,
        enterSelectionModeAndSelectFile,
        addFilesToSelection,
        removeFilesFromSelection
    }), [
        isSelectionMode,
        selectedFiles,
        toggleSelectionMode,
        toggleFileSelection,
        isFileSelected,
        clearSelection,
        selectAllFiles,
        unselectAllFiles,
        enterSelectionModeAndSelectFile,
        addFilesToSelection,
        removeFilesFromSelection
    ]);

    return (
        <FileSelectionContext.Provider value={contextValue}>
            {children}
        </FileSelectionContext.Provider>
    );
};