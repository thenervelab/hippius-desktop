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
    Zip,
    Note,
    DocumentText,
} from "@/components/ui/icons";
import { FileTypes } from "@/lib/types/fileTypes";

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

export const getFileIcon = (fileType: FileTypes | undefined, isFolder: boolean): {
    icon: React.FC<Record<string, unknown>>;
    color: string;
} => {
    if (isFolder) {
        return { icon: Folder2, color: "text-primary-40" };
    }

    switch (fileType) {
        case "video":
            return { icon: Video, color: "text-[#ea4335]" };
        case "audio":
            return { icon: Note, color: "text-[#9b59b6]" };
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
            // SVG icon paints with `fill="currentColor"`, so the text color is
            // the icon color. Plain `text-black` is invisible on dark surfaces
            // (sidebar search palette, dark file rows) — pair it with a light
            // dark-mode variant so the icon stays legible in both themes.
            return { icon: SVG, color: "text-black dark:text-white" };
        case "doc":
            return { icon: Document, color: "text-[#4285F4]" };
        case "image":
            return { icon: Image, color: "text-[#ea4335]" };
        case "archive":
            return { icon: Zip, color: "text-[#f39c12]" };
        case "disk_image":
            return { icon: File, color: "text-primary-70 fill-primary-60" };
        case "markdown":
            return { icon: DocumentText, color: "text-[#4285F4]" };
        case "sql":
            return { icon: Terminal, color: "text-[#4285F4]" };
        default:
            return { icon: File, color: "text-primary-70 fill-primary-60" };
    }
}

// Get icon for thumbnails/white icons (used in FileTypeIcon)
export const getFileIconForThumbnail = (fileType: FileTypes | undefined, isFolder: boolean): {
    icon: React.FC<Record<string, unknown>>;
    color?: string;
} => {
    if (isFolder) {
        return { icon: Folder2, color: "fill-white" };
    }

    switch (fileType) {
        case "video":
            return { icon: Video };
        case "audio":
            return { icon: Note, color: "fill-white" };
        case "ec":
            return { icon: EC, color: "fill-white" };
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
        case "archive":
            return { icon: Zip, color: "fill-white" };
        case "disk_image":
            return { icon: File, color: "fill-white" };
        case "markdown":
            return { icon: DocumentText, color: "fill-white" };
        case "sql":
            return { icon: TerminalWhite };
        default:
            return { icon: File, color: "fill-white" };
    }
}
