import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, LinkIcon, Share, Trash2 } from "lucide-react";
import { Icons } from "@/components/ui";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { toast } from "sonner";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";

interface ContextMenuProps {
    x: number;
    y: number;
    file: FormattedUserIpfsFile | null;
    onClose: () => void;
    onDelete?: (file: FormattedUserIpfsFile) => void;
    onSelectFile?: (file: FormattedUserIpfsFile) => void;
}

export default function FileContextMenu({
    x,
    y,
    file,
    onClose,
    onDelete,
    onSelectFile
}: ContextMenuProps) {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);

        // Close menu on any click outside
        const handleClickOutside = () => onClose();
        document.addEventListener("click", handleClickOutside);

        // Close menu on escape key
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handleEscape);

        return () => {
            document.removeEventListener("click", handleClickOutside);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [onClose]);

    if (!mounted || !file) return null;

    // Calculate position to ensure menu stays within viewport
    const menuStyle = {
        top: `${Math.min(y, window.innerHeight - 250)}px`,
        left: `${Math.min(x, window.innerWidth - 200)}px`,
    };

    // Get file details for menu actions
    const cid = file.cid;
    const name = file.name;
    const { fileFormat } = getFilePartsFromFileName(name);
    const fileType = getFileTypeFromExtension(fileFormat || null);
    const decodedCid = decodeHexCid(cid);

    return createPortal(
        <div
            className="fixed z-50"
            style={menuStyle}
            onClick={(e) => e.stopPropagation()}
        >
            <div className="bg-white border border-grey-80 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] rounded-md overflow-hidden p-0 min-w-[180px]">

                {/* Menu items */}
                <div className="flex flex-col">
                    <button
                        className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-grey-40 hover:bg-grey-95 border-b border-grey-80"
                        onClick={() => {
                            downloadIpfsFile(file);
                            onClose();
                        }}
                    >
                        <Download className="size-4" />
                        <span>Download</span>
                    </button>
                    <button
                        className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-grey-40 hover:bg-grey-95 border-b border-grey-80"
                        onClick={() => {
                            downloadIpfsFile(file);
                            onClose();
                        }}
                    >
                        <Icons.Eye className="size-4" />
                        <span>View</span>
                    </button>
                    <button
                        className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-grey-40 hover:bg-grey-95 border-b border-grey-80"
                        onClick={() => {
                            downloadIpfsFile(file);
                            onClose();
                        }}
                    >
                        <Share className="size-4" />
                        <span>Go To Explorer</span>
                    </button>
                    <button
                        className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-grey-40 hover:bg-grey-95 border-b border-grey-80"
                        onClick={() => {
                            if (fileType === "video" && onSelectFile) {
                                onSelectFile(file);
                            } else {
                                window.open(
                                    `https://get.hippius.network/ipfs/${decodedCid}`,
                                    "_blank"
                                );
                            }
                            onClose();
                        }}
                    >
                        <LinkIcon className="size-4" />
                        <span>View on IPFS</span>
                    </button>

                    <button
                        className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-grey-40 hover:bg-grey-95 border-b border-grey-80"
                        onClick={() => {
                            navigator.clipboard
                                .writeText(`https://get.hippius.network/ipfs/${decodedCid}`)
                                .then(() => {
                                    toast.success("Copied to clipboard successfully!");
                                });
                            onClose();
                        }}
                    >
                        <Copy className="size-4" />
                        <span>Copy Link</span>
                    </button>

                    <button
                        className="flex items-center gap-2 p-2 text-xs font-medium text-grey-30 hover:text-grey-40 hover:bg-grey-95 border-b border-grey-80"
                        onClick={() => {
                            navigator.clipboard
                                .writeText(`https://get.hippius.network/ipfs/${decodedCid}`)
                                .then(() => {
                                    toast.success("Copied to clipboard successfully!");
                                });
                            onClose();
                        }}
                    >
                        <Icons.InfoCircle className="size-4" />
                        <span>File Details</span>
                    </button>



                    {file.isAssigned && (
                        <button
                            className="flex items-center gap-2 p-2 text-xs font-medium text-error-60 hover:text-error-70 hover:bg-grey-95"
                            onClick={() => {
                                if (onDelete) onDelete(file);
                                onClose();
                            }}
                        >
                            <Trash2 className="size-4" />
                            <span>Delete</span>
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
