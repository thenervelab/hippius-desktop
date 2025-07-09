import React, { useState, useEffect, useRef } from 'react';
import { FormattedUserIpfsFile } from '@/lib/hooks/use-user-ipfs-files';
import { getFilePartsFromFileName } from '@/lib/utils/getFilePartsFromFileName';
import { cn } from '@/lib/utils';
import { decodeHexCid } from '@/lib/utils/decodeHexCid';
import { FileTypeIcon } from '@/components/ui';
import { getFileTypeFromExtension } from '@/lib/utils/getTileTypeFromExtension';
import { Graphsheet } from "@/components/ui";

import { Loader2, PlayCircle } from "lucide-react";
import Link from 'next/link';
import { formatDisplayName, getFileIcon, isDirectory } from '@/lib/utils/fileTypeUtils';
import { EC } from '@/components/ui/icons';

interface FileCardProps {
    file: FormattedUserIpfsFile;
    state: 'success' | 'pending' | 'error';
    onClick: () => void;
    actionMenu: React.ReactNode;
}

const FileCard: React.FC<FileCardProps> = ({
    file,
    state,
    onClick,
    actionMenu
}) => {
    const { fileName, fileFormat } = getFilePartsFromFileName(file.name);
    const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
    const [thumbnailError, setThumbnailError] = useState(false);
    const [isLoadingThumbnail, setIsLoadingThumbnail] = useState(false);
    const [loadAttempts, setLoadAttempts] = useState(0);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    const fileType = getFileTypeFromExtension(fileFormat || null);
    const shouldLoadThumbnail = fileType === 'image' || fileType === 'video';
    const isDir = isDirectory(file.name);
    const displayName = formatDisplayName(file.name);
    const { icon: Icon, color } = getFileIcon(fileType, isDir);

    useEffect(() => {
        if (
            thumbnailUrl ||
            thumbnailError ||
            !shouldLoadThumbnail ||
            loadAttempts >= 2 ||
            isLoadingThumbnail
        ) {
            return;
        }

        // Clear any existing timeout
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
        }

        setIsLoadingThumbnail(true);
        setLoadAttempts(prev => prev + 1);

        const handleError = () => {
            setThumbnailError(true);
            setIsLoadingThumbnail(false);
        };

        if (fileType === 'image') {
            const img = document.createElement('img');
            img.onload = () => {
                setThumbnailUrl(`https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`);
                setIsLoadingThumbnail(false);
            };
            img.onerror = handleError;
            img.src = `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`;

            timeoutRef.current = setTimeout(() => {
                if (!thumbnailUrl) {
                    handleError();
                }
            }, 10000);

        } else if (fileType === 'video') {
            // For videos, we'll generate a thumbnail by loading the video and capturing a frame
            const videoUrl = `https://get.hippius.network/ipfs/${decodeHexCid(file.cid)}`;

            // Create a video element to load the video and generate thumbnail
            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.src = videoUrl;
            video.preload = 'metadata';

            // Set a global timeout for the entire video thumbnail generation process
            timeoutRef.current = setTimeout(() => {
                handleError();
            }, 15000); // 15 seconds total timeout

            // When video metadata is loaded, seek to a point and capture thumbnail
            video.onloadedmetadata = () => {
                try {
                    // Seek to 1 second or 25% of the video duration, whichever is less
                    const seekTime = Math.min(1, video.duration * 0.25);
                    video.currentTime = seekTime;

                    video.onseeked = () => {
                        try {
                            // Create a canvas to capture the video frame
                            const canvas = document.createElement('canvas');
                            canvas.width = video.videoWidth || 300;
                            canvas.height = video.videoHeight || 200;
                            const ctx = canvas.getContext('2d');

                            if (ctx) {
                                // Draw the current video frame to the canvas
                                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                                try {
                                    // Convert canvas to data URL for the thumbnail
                                    const dataUrl = canvas.toDataURL('image/jpeg');
                                    setThumbnailUrl(dataUrl);
                                    setIsLoadingThumbnail(false);
                                    if (timeoutRef.current) clearTimeout(timeoutRef.current);
                                } catch (e) {
                                    console.error('Error creating video thumbnail:', e);
                                    handleError();
                                }
                            } else {
                                handleError();
                            }
                        } catch (err) {
                            console.error('Error in video seek handler:', err);
                            handleError();
                        }
                    };
                } catch (err) {
                    console.error('Error in video metadata handler:', err);
                    handleError();
                }
            };

            video.onerror = () => {
                console.error('Error loading video for thumbnail');
                handleError();
            };

            setTimeout(() => {
                if (isLoadingThumbnail && !thumbnailUrl) {
                    handleError();
                }
            }, 5000);
        }

        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, [file.cid, fileType, thumbnailUrl, thumbnailError, loadAttempts, shouldLoadThumbnail]);

    return (
        <div
            className={cn(
                "w-full relative border border-grey-80 rounded-lg overflow-hidden aspect-[4/3]",
                state === "pending" && "animate-pulse",
                state === "error" && "bg-red-200/20 border-red-300"
            )}
        >
            {/* Graphsheet Background */}
            {!isDir && (<Graphsheet
                majorCell={{
                    lineColor: [31, 80, 189, 1.0],
                    lineWidth: 2,
                    cellDim: 50,
                }}
                minorCell={{
                    lineColor: [255, 255, 255, 1.0],
                    lineWidth: 0,
                    cellDim: 0,
                }}
                className="absolute w-full h-full left-0 opacity-10"
            />)}

            {/* Header with filename and actions */}
            <div className="p-2 flex items-center justify-between relative bg-white bg-opacity-80 border-b border-grey-80 h-[40px]">
                {isDir ? (
                    <Link href={`/dashboard/storage/ipfs/${decodeHexCid(file.cid)}`}>
                        <div className="flex items-center">
                            <Icon className={cn("size-5 mr-1", color)} />
                            <span className={cn("text-sm text-grey-20 hover:text-primary-40 transition truncate max-w-[200px]")}>
                                {displayName}
                            </span>
                        </div>
                    </Link>
                ) : (
                    <div className="flex items-center">
                        <Icon className={cn("size-5 mr-1", color)} />
                        <span className="text-sm text-grey-20 truncate max-w-[200px]">{displayName}</span>
                    </div>
                )}
                <div className="flex-shrink-0">
                    {actionMenu}
                </div>
            </div>

            <div
                className="flex items-center justify-center cursor-pointer relative h-[calc(100%-40px)]"
                onClick={onClick}
            >
                {thumbnailUrl && !thumbnailError ? (
                    <div className="relative w-full h-full">
                        <img
                            src={thumbnailUrl}
                            alt={fileName}
                            className="h-full w-full object-cover"
                            onError={() => setThumbnailError(true)}
                        />

                        {fileType === 'video' && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-20 hover:bg-opacity-30 transition-all">
                                <PlayCircle className="size-12 text-white opacity-80 hover:opacity-100" />
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center p-4 h-full w-full">
                        {isLoadingThumbnail && shouldLoadThumbnail ? (
                            <div className="flex flex-col items-center justify-center space-y-2">
                                <Loader2 className="h-8 w-8 animate-spin text-primary-50" />
                                <span className="text-xs text-gray-500">
                                    Loading preview...
                                </span>
                            </div>
                        ) : (
                            <div className="flex items-center sm:justify-center h-[56px] w-[56px] relative">
                                {isDir ? (
                                    <div>
                                        <Graphsheet
                                            majorCell={{ lineColor: [31, 80, 189, 1], lineWidth: 2, cellDim: 40 }}
                                            minorCell={{ lineColor: [31, 80, 189, 1], lineWidth: 2, cellDim: 40 }}
                                            className="absolute w-full h-full top-0 bottom-0 left-0 duration-300 opacity-10"
                                        />
                                        <EC className='size-10 text-primary-50' />
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-center size-9 bg-primary-50 rounded-[8px] relative">
                                        <FileTypeIcon
                                            fileType={fileType}
                                            rawName={file.name}
                                            cid={file.cid}
                                            size='md'
                                            className='text-grey-100'
                                        />
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default FileCard;
