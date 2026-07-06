import React, { createContext, useContext, useState, ReactNode, useMemo, useCallback } from 'react';
import { FormattedUserFile } from '../lib/hooks/use-user-files';
import { selectionKey, removeDescendantsFromSelection } from './fileSelectionLogic';

interface FileSelectionContextProps {
    isSelectionMode: boolean;
    selectedFiles: FormattedUserFile[];
    toggleSelectionMode: () => void;
    toggleFileSelection: (file: FormattedUserFile) => void;
    toggleFolderSelection: (folder: FormattedUserFile) => void;
    isFileSelected: (file: FormattedUserFile) => boolean;
    clearSelection: () => void;
    selectAllFiles: (files: FormattedUserFile[]) => void;
    unselectAllFiles: () => void;
    enterSelectionModeAndSelectFile: (file: FormattedUserFile) => void;
    addFilesToSelection: (files: FormattedUserFile[]) => void;
    removeFileFromSelection: (file: FormattedUserFile) => void;
    removeFilesFromSelection: (files: FormattedUserFile[]) => void;
    /**
     * Drops every entry under `folder` (same label, path prefix match)
     * from the selection set, without removing the folder itself. Used
     * by the cascade-split path so a folder visually "unchecks" cleanly
     * after the user clicks a single descendant.
     */
    removeDescendantsOf: (folder: FormattedUserFile) => void;
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
                setSelectedFiles([]);
            }
            return !prev;
        });
    }, []);

    const toggleFileSelection = useCallback((file: FormattedUserFile) => {
        if (!file.isAssigned) {
            return;
        }
        const key = selectionKey(file);
        setSelectedFiles(prevSelected => {
            const exists = prevSelected.some(f => selectionKey(f) === key);
            if (exists) {
                return prevSelected.filter(f => selectionKey(f) !== key);
            }
            return [...prevSelected, file];
        });
    }, []);

    /**
     * Folder-specific toggle. Selecting a folder subsumes any
     * individually-selected descendants — once the folder is in the
     * set, those children are visually represented by the cascade so
     * keeping them around would just double-count at delete time.
     * Mirrors the console's `toggleFolderSelection`.
     */
    const toggleFolderSelection = useCallback((folder: FormattedUserFile) => {
        if (!folder.isAssigned) {
            return;
        }
        const folderKey = selectionKey(folder);
        setSelectedFiles(prevSelected => {
            const alreadySelected = prevSelected.some(f => selectionKey(f) === folderKey);
            if (alreadySelected) {
                return prevSelected.filter(f => selectionKey(f) !== folderKey);
            }
            // Drop any descendants of this folder — the folder itself
            // now represents them in the selection set.
            const withoutDescendants = removeDescendantsFromSelection(prevSelected, folder);
            return [...withoutDescendants, folder];
        });
    }, []);

    const isFileSelected = useCallback((file: FormattedUserFile) => {
        const key = selectionKey(file);
        return selectedFiles.some(f => selectionKey(f) === key);
    }, [selectedFiles]);

    const clearSelection = useCallback(() => {
        setSelectedFiles([]);
        setIsSelectionMode(false);
    }, []);

    const selectAllFiles = useCallback((files: FormattedUserFile[]) => {
        const deletableFiles = files.filter(file => file.isAssigned);
        setSelectedFiles(deletableFiles);
    }, []);

    const unselectAllFiles = useCallback(() => {
        setSelectedFiles([]);
    }, []);

    const enterSelectionModeAndSelectFile = useCallback((file: FormattedUserFile) => {
        if (!file.isAssigned) {
            return;
        }
        setIsSelectionMode(true);
        setSelectedFiles([file]);
    }, []);

    const addFilesToSelection = useCallback((files: FormattedUserFile[]) => {
        const deletableFiles = files.filter(file => file.isAssigned);
        setSelectedFiles(prevSelected => {
            const selectedKeys = new Set(prevSelected.map(selectionKey));
            const newFiles = deletableFiles.filter(file => !selectedKeys.has(selectionKey(file)));
            return [...prevSelected, ...newFiles];
        });
    }, []);

    const removeFileFromSelection = useCallback((file: FormattedUserFile) => {
        const key = selectionKey(file);
        setSelectedFiles(prevSelected => prevSelected.filter(f => selectionKey(f) !== key));
    }, []);

    const removeFilesFromSelection = useCallback((files: FormattedUserFile[]) => {
        setSelectedFiles(prevSelected => {
            const keysToRemove = new Set(files.map(selectionKey));
            return prevSelected.filter(file => !keysToRemove.has(selectionKey(file)));
        });
    }, []);

    const removeDescendantsOf = useCallback((folder: FormattedUserFile) => {
        setSelectedFiles(prevSelected => removeDescendantsFromSelection(prevSelected, folder));
    }, []);

    const contextValue = useMemo(() => ({
        isSelectionMode,
        selectedFiles,
        toggleSelectionMode,
        toggleFileSelection,
        toggleFolderSelection,
        isFileSelected,
        clearSelection,
        selectAllFiles,
        unselectAllFiles,
        enterSelectionModeAndSelectFile,
        addFilesToSelection,
        removeFileFromSelection,
        removeFilesFromSelection,
        removeDescendantsOf
    }), [
        isSelectionMode,
        selectedFiles,
        toggleSelectionMode,
        toggleFileSelection,
        toggleFolderSelection,
        isFileSelected,
        clearSelection,
        selectAllFiles,
        unselectAllFiles,
        enterSelectionModeAndSelectFile,
        addFilesToSelection,
        removeFileFromSelection,
        removeFilesFromSelection,
        removeDescendantsOf
    ]);

    return (
        <FileSelectionContext.Provider value={contextValue}>
            {children}
        </FileSelectionContext.Provider>
    );
};

export { selectionKey };
