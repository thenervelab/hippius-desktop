export type FileTypes = "image" | "video" | "document" | "ec";

export const DEFAULT_FILE_FORMAT: FileTypes = "document";

const extensionGroups: Record<FileTypes, string[]> = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"],
  video: ["mp4", "mov", "avi", "mkv", "webm"],
  document: ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "txt"],
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

  return DEFAULT_FILE_FORMAT;
};

export const getFilePartsFromFileName = (name: string) => {
  const parts = name.split(".");
  const fileName = parts[0];
  const fileFormat = parts[parts.length - 1];
  return {
    fileName,
    fileFormat,
  };
};
