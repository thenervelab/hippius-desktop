import React from 'react';
import {
    Document,
    Video,
    Image,
    ImageWhite,
    PDF,
    Presentation,
    Sheet,
    SVG,
    Terminal,
    TerminalWhite,
    EC,
    File,
    Folder2,
} from "@/components/ui/icons";
import { FileTypes } from "@/lib/types/fileTypes";

export const DEFAULT_FILE_FORMAT: FileTypes = "document";

export const DIRECTORY_SUFFIX = ".ec_metadata";

export const isDirectory = (filename: string): boolean => {
    return filename.endsWith(DIRECTORY_SUFFIX);
}

export const formatDisplayName = (rawName: string): string => {
    let name = isDirectory(rawName) ? rawName.slice(0, -DIRECTORY_SUFFIX.length) : rawName;

    if (name.length > 20) {
        const extIndex = name.lastIndexOf(".");
        if (extIndex !== -1 && extIndex !== 0 && extIndex !== name.length - 1) {
            const base = name.slice(0, extIndex);
            const ext = name.slice(extIndex); // includes the dot
            if (base.length > 20) {
                name = `${base.slice(0, 10)}...${base.slice(-7)}${ext}`;
            } else {
                name = `${base}${ext}`;
            }
        } else {
            name = `${name.slice(0, 10)}...${name.slice(-7)}`;
        }
    }

    return name;
}

export const getFileIcon = (fileType: FileTypes | undefined, isDir: boolean): {
    icon: React.FC<Record<string, unknown>>;
    color: string;
} => {
    if (isDir) {
        return { icon: Folder2, color: "text-primary-40" };
    }

    switch (fileType) {
        case "video":
            return { icon: Video, color: "text-[#ea4335]" };
        case "ec":
            return { icon: EC, color: "text-primary-40" };
        case "document":
            return { icon: File, color: "text-primary-70 fill-primary-60" };
        case "PDF":
            return { icon: PDF, color: "text-[#ea4335]" };
        case "PPT":
            return { icon: Presentation, color: "text-[#fbbc04]" };
        case "XLS":
            return { icon: Sheet, color: "text-[#34a853]" };
        case "code":
            return { icon: Terminal, color: "text-[#4285F4]" };
        case "svg":
            return { icon: SVG, color: "text-black" };
        case "doc":
            return { icon: Document, color: "text-[#4285F4]" };
        case "image":
            return { icon: Image, color: "text-[#ea4335]" };
        default:
            return { icon: File, color: "text-primary-70 fill-primary-60" };
    }
}

// Get icon for thumbnails/white icons (used in FileTypeIcon)
export const getFileIconForThumbnail = (fileType: FileTypes | undefined, isDir: boolean): {
    icon: React.FC<Record<string, unknown>>;
    color?: string;
} => {
    if (isDir) {
        return { icon: EC };
    }

    switch (fileType) {
        case "video":
            return { icon: Video };
        case "ec":
            return { icon: EC };
        case "document":
            return { icon: File, color: "fill-white" };
        case "PDF":
            return { icon: PDF };
        case "PPT":
            return { icon: Presentation };
        case "XLS":
            return { icon: Sheet };
        case "code":
            return { icon: TerminalWhite };
        case "svg":
            return { icon: SVG };
        case "doc":
            return { icon: Document };
        case "image":
            return { icon: ImageWhite };
        default:
            return { icon: File, color: "fill-white" };
    }
}
