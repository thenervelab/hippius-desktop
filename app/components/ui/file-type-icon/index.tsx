import React from 'react';
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { FileTypes } from "@/lib/types/fileTypes";
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { getFileIconForThumbnail, isDirectory } from '@/lib/utils/fileTypeUtils';

interface FileTypeIconProps {
    fileType?: FileTypes;
    className?: string;
    iconClassName?: string;
    rawName: string;
    cid: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
}

const FileTypeIcon: React.FC<FileTypeIconProps> = ({
    fileType,
    rawName,
    className,
    iconClassName,
    cid,
    size = 'md',
}) => {
    const sizeClassMap = {
        sm: 'size-4',
        md: 'size-5',
        lg: 'size-10',
        xl: 'size-16'
    };

    const iconSizeClass = sizeClassMap[size];
    const isDir = isDirectory(rawName);
    const { icon: Icon, color: iconColor } = getFileIconForThumbnail(fileType, isDir);

    return (
        <div className={cn(className)}>
            {isDir ? (
                <Link href={`/dashboard/storage/ipfs/${decodeHexCid(cid)}`}>
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
