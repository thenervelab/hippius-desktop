import { convertFileSrc } from "@tauri-apps/api/core";

export interface FileUrlResult {
  url: string;
  isLocal: boolean;
}

/**
 * Checks if a file source indicates it's a local file
 */
export const isLocalFile = (source?: string): boolean => {
  return Boolean(
    source &&
    (source.includes('/') || source.includes('\\'))
  );
};

/**
 * Resolves a file to its local Tauri asset URL.
 * All files are local now (synced via HCFS).
 */
export const getFileUrl = (file: { source?: string }): FileUrlResult => {
  if (file.source && isLocalFile(file.source)) {
    const normalised = file.source.replace(/\\/g, "/");
    return {
      url: convertFileSrc(normalised),
      isLocal: true,
    };
  }

  return {
    url: "",
    isLocal: false,
  };
};
