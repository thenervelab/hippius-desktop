import React from 'react';
import { FileTypes } from "@/lib/types/fileTypes";
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { getFileIconForThumbnail } from '@/lib/utils/fileTypeUtils';
import { FormattedUserIpfsFile } from '@/app/lib/hooks/use-user-ipfs-files';
import { useUrlParams } from '@/app/utils/hooks/useUrlParams';
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";

interface FileTypeIconProps {
    fileType?: FileTypes;
    className?: string;
    iconClassName?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    file: FormattedUserIpfsFile
}

const FileTypeIcon: React.FC<FileTypeIconProps> = ({
    fileType,
    className,
    iconClassName,
    size = 'md',
    file
}) => {
    const sizeClassMap = {
        sm: 'size-4',
        md: 'size-5',
        lg: 'size-10',
        xl: 'size-16'
    };

    const { getParam } = useUrlParams();
    const iconSizeClass = sizeClassMap[size];
    const { icon: Icon, color: iconColor } = getFileIconForThumbnail(fileType, !!file.isFolder);

    // Get folder URL from the utility function
    const { url: folderUrl } = file.isFolder ? generateFolderUrl(file, getParam) : { url: '' };

    return (
        <div className={cn(className)}>
            {file.isFolder ? (
                <Link href={folderUrl}>
                    <div className="flex items-center justify-center">
                        <Icon className={cn("text-grey-100", iconSizeClass, iconClassName)} />
                    </div>
                </Link>
            ) : (
                <div className="flex items-center justify-center">
                    <Icon className={cn("text-grey-100", iconSizeClass, iconClassName, iconColor)} fill="white" />
                </div>
            )}
        </div>
    );
};

export default FileTypeIcon;
