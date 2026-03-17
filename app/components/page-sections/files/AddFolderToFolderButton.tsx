"use client";

import React, { useState, forwardRef, useImperativeHandle } from "react";
import { Icons } from "@/components/ui";
import FolderToFolderUploadDialog from "./FolderToFolderUploadDialog";

interface AddFolderToFolderButtonProps {
    className?: string;
    folderName: string;
    isPrivateFolder: boolean;
    mainFolderActualName?: string;
    subFolderPath?: string;
    onFolderAdded?: () => void;
    disabled?: boolean;
    syncBasePath?: string;
}

const AddFolderToFolderButton = forwardRef<unknown, AddFolderToFolderButtonProps>(
    (
        {
            folderName,
            isPrivateFolder,
            mainFolderActualName,
            subFolderPath,
            onFolderAdded,
            disabled,
            syncBasePath
        },
        ref
    ) => {
        const [isDialogOpen, setIsDialogOpen] = useState(false);

        useImperativeHandle(ref, () => ({}));

        return (
            <>
                <button
                    onClick={() => setIsDialogOpen(true)}
                    disabled={disabled}
                    className={`flex items-center justify-center gap-1 h-9 px-4 py-2 rounded bg-grey-90 text-grey-10 hover:bg-grey-80 transition-colors ${disabled ? 'opacity-50 cursor-not-allowed hover:bg-grey-90' : ''}`}
                >
                    <Icons.FolderAdd className="size-4" />
                    <span className="ml-1">Add Folder</span>
                </button>

                <FolderToFolderUploadDialog
                    open={isDialogOpen}
                    onClose={() => setIsDialogOpen(false)}
                    onRefresh={onFolderAdded}
                    isPrivateFolder={isPrivateFolder}
                    parentFolderName={folderName}
                    mainFolderActualName={mainFolderActualName}
                    subFolderPath={subFolderPath}
                    syncBasePath={syncBasePath}
                />
            </>
        );
    }
);

AddFolderToFolderButton.displayName = "AddFolderToFolderButton";

export default AddFolderToFolderButton;
