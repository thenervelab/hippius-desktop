import React from 'react';
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { FileTypes } from "@/lib/types/fileTypes";
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { getFileIconForThumbnail } from '@/lib/utils/fileTypeUtils';
import { FormattedUserIpfsFile } from '@/app/lib/hooks/use-user-ipfs-files';
import { useUrlParams } from '@/app/utils/hooks/useUrlParams';
import { buildFolderPath } from '@/app/utils/folderPathUtils';

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

    // Get current path information
    const folderCid = getParam("folderCid", "");
    const mainFolderCid = getParam("mainFolderCid", "");
    const folderActualName = getParam("folderActualName", "");
    const mainFolderActualName = getParam("mainFolderActualName", "");
    const subFolderPath = getParam("subFolderPath", "");

    // Build the folder path for navigation
    const { mainFolderCid: newMainFolderCID, mainFolderActualName: newMainFolder, subFolderPath: newSubFolderPath } = buildFolderPath(
        folderActualName,
        mainFolderCid || folderCid,
        mainFolderActualName || folderActualName,
        subFolderPath
    );

    return (
        <div className={cn(className)}>
            {file.isFolder ? (
                <Link href={`/files?folderCid=${decodeHexCid(file.cid)}&folderName=${encodeURIComponent(file.name)}&mainFolderCid=${encodeURIComponent(newMainFolderCID)}&folderActualName=${encodeURIComponent(file.actualFileName ?? "")}&mainFolderActualName=${encodeURIComponent(newMainFolder)}&subFolderPath=${encodeURIComponent(newSubFolderPath)}`}>
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
