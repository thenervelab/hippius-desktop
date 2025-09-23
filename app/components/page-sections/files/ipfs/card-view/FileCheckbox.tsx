import React from 'react';
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { useFileSelection } from '@/app/contexts/FileSelectionContext';
import { FormattedUserIpfsFile } from '@/lib/hooks/use-user-ipfs-files';

interface FileCheckboxProps {
    file: FormattedUserIpfsFile;
    className?: string;
}

const FileCheckbox: React.FC<FileCheckboxProps> = ({ file, className = "" }) => {
    const { isSelectionMode, isFileSelected, toggleFileSelection } = useFileSelection();

    if (!isSelectionMode) {
        return null;
    }

    const selected = isFileSelected(file);
    const disabled = !file.isAssigned; // Only allow selection of deletable files

    return (
        <div className={`absolute top-2 left-2 z-10 ${className}`}>
            <Checkbox.Root
                className="h-5 w-5 rounded border border-grey-70 flex items-center justify-center bg-white/80 backdrop-blur-sm data-[state=checked]:bg-primary-50 data-[state=checked]:border-primary-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                checked={selected}
                onCheckedChange={() => !disabled && toggleFileSelection(file)}
                disabled={disabled}
            >
                <Checkbox.Indicator>
                    <Check className="h-3.5 w-3.5 text-white" />
                </Checkbox.Indicator>
            </Checkbox.Root>
        </div>
    );
};

export default FileCheckbox;