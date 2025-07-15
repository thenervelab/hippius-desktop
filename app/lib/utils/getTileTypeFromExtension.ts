import { FileTypes } from "@/lib/types/fileTypes";
import { SUPPORTED_VIDEO_FORMATS } from "@/lib/constants/supportedFileTypes";

export const SUPPORTED_FILE_TYPES = [
    "image",
    "video",
    "pdfDocument",
    "presentationDocument",
    "spreadSheet",
    "document",
    "doc",
    "ec",
    "code",
    "svg",
] as const;

export const extensionGroups: Record<FileTypes, string[]> = {
    image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico"],
    video: SUPPORTED_VIDEO_FORMATS as unknown as string[],
    document: ["txt", "csv"],
    doc: ["doc", "docx"],
    code: ["json"],
    svg: ["svg"],
    pdfDocument: ["pdf"],
    presentationDocument: ["ppt", "pptx"],
    spreadSheet: ["xls", "xlsx"],
    ec: ["ec_metadata"],
};

export const getFileTypeFromExtension = (
    extension: string | null
): FileTypes | null => {
    if (!extension) return null;
    const ext = extension.toLowerCase();

    for (const [type, extensions] of Object.entries(extensionGroups)) {
        if (extensions.includes(ext)) {
            return type as FileTypes;
        }
    }

    return null;
};
