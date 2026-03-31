import { FileTypes } from "@/lib/types/fileTypes";
import { SUPPORTED_VIDEO_FORMATS } from "@/lib/constants/supportedFileTypes";

export const SUPPORTED_FILE_TYPES = [
    "image",
    "video",
    "audio",
    "PDF",
    "PPT",
    "XLS",
    "document",
    "doc",
    "ec",
    "code",
    "sql",
    "svg",
    "folder",
    "archive",
    "disk_image",
    "markdown",
] as const;

export const extensionGroups: Record<FileTypes, string[]> = {
    image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "tiff", "tif", "heic", "heif", "avif", "raw"],
    video: SUPPORTED_VIDEO_FORMATS as unknown as string[],
    audio: ["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "opus", "aiff", "alac"],
    document: ["txt", "csv", "rtf", "log", "ini", "cfg", "conf"],
    doc: ["doc", "docx", "odt"],
    code: ["json", "js", "ts", "jsx", "tsx", "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php", "swift", "kt", "html", "css", "scss", "less", "yaml", "yml", "toml", "xml", "sh", "bash", "zsh", "bat", "ps1"],
    sql: ["sql", "db", "sqlite", "sqlite3"],
    svg: ["svg"],
    PDF: ["pdf"],
    PPT: ["ppt", "pptx", "odp"],
    XLS: ["xls", "xlsx", "ods"],
    ec: ["ec_metadata"],
    folder: ["folder", "folder.ec_metadata", "folder.ec"],
    archive: ["zip", "tar", "gz", "bz2", "xz", "rar", "7z", "tgz", "war", "jar", "pkg", "deb", "rpm", "apk"],
    disk_image: ["dmg", "iso", "img"],
    markdown: ["md", "mdx"],
};

/** Human-readable display labels for each file type category. */
export const fileTypeDisplayLabels: Record<FileTypes, string> = {
    image: "Image",
    video: "Video",
    audio: "Audio",
    PDF: "PDF",
    PPT: "Presentation",
    XLS: "Spreadsheet",
    document: "Document",
    doc: "Document",
    ec: "Encrypted",
    code: "Code",
    sql: "Database",
    svg: "SVG",
    folder: "Folder",
    archive: "Archive",
    disk_image: "Disk Image",
    markdown: "Markdown",
};

/** Returns a human-readable display label for a FileTypes value, or "Document" for unknown. */
export const getFileTypeDisplayLabel = (
    fileType: FileTypes | null | undefined,
    isFolder?: boolean,
): string => {
    if (isFolder) return "Folder";
    if (!fileType) return "Unknown";
    return fileTypeDisplayLabels[fileType] ?? "Unknown";
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
