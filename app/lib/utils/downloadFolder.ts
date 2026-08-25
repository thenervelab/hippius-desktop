import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "@/lib/utils/errorUtils";
import { join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

interface FilePathInfo {
  sync_path: string;
  relative_name: string;
}

/** Save-dialog filter for the folder-as-zip export. Keep in sync with
 *  `export_folder_zip` — the archive is always a `.zip`. */
export const FOLDER_ZIP_DIALOG_FILTERS: { name: string; extensions: string[] }[] = [
  { name: "Zip Archive", extensions: ["zip"] },
];

export function defaultFolderZipFileName(folderName: string): string {
  return `${folderName}.zip`;
}

export interface DownloadFolderOptions {
  folderName: string;
  polkadotAddress: string;
  file?: FormattedUserFile;
}

export const downloadFolder = async ({
  folderName,
  polkadotAddress,
  file,
}: DownloadFolderOptions) => {
  const { downloadDir } = await import("@tauri-apps/api/path");
  let downloadDirPath: string | undefined;
  try {
    downloadDirPath = await downloadDir();
  } catch {
    // Fall back to a bare filename hint
  }

  const zipName = defaultFolderZipFileName(folderName);
  const defaultPath = downloadDirPath
    ? await join(downloadDirPath, zipName)
    : zipName;

  const outputZipPath = await save({
    filters: FOLDER_ZIP_DIALOG_FILTERS,
    defaultPath,
  });
  if (!outputZipPath) {
    return { success: false, error: "Download cancelled" };
  }

  const toastId = toast.info("Downloading folder...", { duration: Infinity });

  try {
    const info = await invoke<FilePathInfo>("resolve_file_info", {
      accountId: polkadotAddress,
      label: file?.label ?? null,
      source: file?.source ?? null,
      fileName: file?.actualFileName || folderName,
    });

    await invoke("export_folder_zip", {
      syncPath: info.sync_path,
      relativeFolder: info.relative_name,
      outputZipPath,
    });

    toast.dismiss(toastId);
    toast.success("Folder downloaded successfully!");
    return { success: true };
  } catch (error) {
    toast.dismiss(toastId);
    console.error("Folder download failed:", error);
    const message = errorMessage(error);
    toast.error(`Failed to download folder: ${message}`);
    return {
      success: false,
      error: "DOWNLOAD_FAILED",
      message,
    };
  }
};
