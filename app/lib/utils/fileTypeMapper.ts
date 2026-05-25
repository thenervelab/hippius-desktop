/**
 * Specific file-extension filter values. Ported from the web console
 * (`hippius-console/src/lib/utils/file-type-mapper.ts`) so the desktop
 * filter dropdown shows the same grouped extension list and the matching
 * rules stay aligned across both clients.
 *
 * Stored as the raw extension string ("mp4", "jpg") rather than a coarse
 * category — the desktop's Rust backend honours both via two separate
 * filter fields (`fileTypes` for legacy category match, `fileExtensions`
 * for the new specific-extension match). This util only deals with the
 * specific-extension shape.
 */
export type FileExtension = string;

export type FileSizeLabel =
    | "< 1MB"
    | "1-5MB"
    | "5-10MB"
    | "10-50MB"
    | "50-100MB"
    | "100-500MB"
    | "500MB-1GB"
    | "> 1GB";

/** Lower-case the extension for the API. Mirrors the console's mapper. */
export function mapFileExtensionToAPI(extension: FileExtension | undefined): string | undefined {
    return extension?.toLowerCase();
}

/**
 * Translate a file-size label into a `{sizeMin, sizeMax}` byte window.
 * Uses decimal MB / GB (1 MB = 1_000_000) so the labels stay aligned
 * with the byte counts `formatBytes` prints. Same shape as the console's
 * mapper so a chip displayed as "1-5MB" filters the same range on both.
 */
export function mapFileSizeToRange(sizeLabel: FileSizeLabel | undefined): {
    sizeMin?: number;
    sizeMax?: number;
} {
    if (!sizeLabel) return {};

    const MB = 1_000_000;
    const GB = 1_000_000_000;

    const sizeRanges: Record<FileSizeLabel, { sizeMin?: number; sizeMax?: number }> = {
        "< 1MB": { sizeMax: MB },
        "1-5MB": { sizeMin: MB, sizeMax: 5 * MB },
        "5-10MB": { sizeMin: 5 * MB, sizeMax: 10 * MB },
        "10-50MB": { sizeMin: 10 * MB, sizeMax: 50 * MB },
        "50-100MB": { sizeMin: 50 * MB, sizeMax: 100 * MB },
        "100-500MB": { sizeMin: 100 * MB, sizeMax: 500 * MB },
        "500MB-1GB": { sizeMin: 500 * MB, sizeMax: GB },
        "> 1GB": { sizeMin: GB },
    };

    return sizeRanges[sizeLabel] ?? {};
}

/**
 * The full flat list of selectable extensions, grouped by category.
 * Ported 1:1 from the web console so the same options surface on both.
 *
 * The `icon` field is a *name* (not a component) so this util has no
 * React dependency. The selector component maps name → component locally.
 */
export function getFileExtensions(): Array<{
    value: FileExtension;
    label: string;
    category: string;
    icon: string;
}> {
    return [
        // Video extensions
        { value: "mp4", label: "MP4", category: "Video", icon: "video" },
        { value: "mkv", label: "MKV", category: "Video", icon: "video" },
        { value: "avi", label: "AVI", category: "Video", icon: "video" },
        { value: "mov", label: "MOV", category: "Video", icon: "video" },
        { value: "webm", label: "WEBM", category: "Video", icon: "video" },

        // Image extensions
        { value: "jpg", label: "JPG", category: "Image", icon: "image" },
        { value: "jpeg", label: "JPEG", category: "Image", icon: "image" },
        { value: "png", label: "PNG", category: "Image", icon: "image" },
        { value: "gif", label: "GIF", category: "Image", icon: "image" },
        { value: "svg", label: "SVG", category: "Image", icon: "svg" },
        { value: "webp", label: "WEBP", category: "Image", icon: "image" },

        // Document extensions
        { value: "pdf", label: "PDF", category: "Document", icon: "pdf" },
        { value: "doc", label: "DOC", category: "Document", icon: "document" },
        { value: "docx", label: "DOCX", category: "Document", icon: "document" },
        { value: "txt", label: "TXT", category: "Document", icon: "file" },

        // Spreadsheet extensions
        { value: "xls", label: "XLS", category: "Spreadsheet", icon: "sheet" },
        { value: "xlsx", label: "XLSX", category: "Spreadsheet", icon: "sheet" },
        { value: "csv", label: "CSV", category: "Spreadsheet", icon: "sheet" },

        // Presentation extensions
        { value: "ppt", label: "PPT", category: "Presentation", icon: "presentation" },
        { value: "pptx", label: "PPTX", category: "Presentation", icon: "presentation" },

        // Code extensions
        { value: "json", label: "JSON", category: "Code", icon: "code" },
        { value: "js", label: "JavaScript", category: "Code", icon: "code" },
        { value: "ts", label: "TypeScript", category: "Code", icon: "code" },
        { value: "py", label: "Python", category: "Code", icon: "code" },
        { value: "html", label: "HTML", category: "Code", icon: "code" },
        { value: "css", label: "CSS", category: "Code", icon: "code" },

        // Database extensions
        { value: "sql", label: "SQL", category: "Database", icon: "database" },
        { value: "db", label: "DB", category: "Database", icon: "database" },
    ];
}
