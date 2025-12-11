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
            console.log('File not assigned, cannot select:', file.name, file.isAssigned);
            return;
        }

        console.log('Toggle selection for:', {
            name: file.name,
            actualFileName: file.actualFileName,
            isFolder: file.isFolder
        });

        setSelectedFiles(prevSelected => {
            console.log('Current selected files:', prevSelected.map(f => ({ name: f.name, actualFileName: f.actualFileName })));
            const isSelected = prevSelected.some(f => f.actualFileName === file.actualFileName);
            console.log('Is currently selected:', isSelected);

            if (isSelected) {
                const newSelection = prevSelected.filter(f => f.actualFileName !== file.actualFileName);
                console.log('After deselection:', newSelection.map(f => ({ name: f.name, actualFileName: f.actualFileName })));
                return newSelection;
            } else {
                const newSelection = [...prevSelected, file];
                console.log('After selection:', newSelection.map(f => ({ name: f.name, actualFileName: f.actualFileName })));
                return newSelection;
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

        console.log("Entering selection mode with file:", {
            name: file.name,
            actualFileName: file.actualFileName,
            isFolder: file.isFolder,
            isAssigned: file.isAssigned
        });

        // Set selection mode and select the file in one atomic operation
        setIsSelectionMode(true);
        setSelectedFiles([file]);

        console.log("Selection mode activated with file:", file.actualFileName);
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
        enterSelectionModeAndSelectFile
    }), [
        isSelectionMode,
        selectedFiles,
        toggleSelectionMode,
        toggleFileSelection,
        isFileSelected,
        clearSelection,
        selectAllFiles,
        unselectAllFiles,
        enterSelectionModeAndSelectFile
    ]);

    return (
        <FileSelectionContext.Provider value={contextValue}>
            {children}
        </FileSelectionContext.Provider>
    );
};