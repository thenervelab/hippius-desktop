import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { errorMessage } from "@/lib/utils/errorUtils";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";

interface FilePathInfo {
  sync_path: string;
  relative_name: string;
}

const getFileSavePath = async (name: string, directory?: string) => {
  const fileExtension = name.split(".").pop() || "";
  const defaultPath = directory ? `${directory}/${name}` : name;
  return await save({
    filters: [
      {
        name: fileExtension
          ? `${fileExtension.toUpperCase()} File`
          : "All Files",
        extensions: [fileExtension || "*"]
      }
    ],
    defaultPath,
  });
};

export const downloadFile = async (
  file: FormattedUserFile,
  polkadotAddress: string,
) => {
  if (file.isFolder) {
    return downloadFolderExport(file, polkadotAddress);
  }
  return downloadFileExport(file, polkadotAddress);
};

const downloadFileExport = async (
  file: FormattedUserFile,
  polkadotAddress: string
) => {
  const { name } = file;
  const toastId = toast.loading(`Preparing download: ${name}`);

  try {
    // Only a server-only hit (no `source`) or a pending *search* hit (carries a
    // server `fileId` but isn't on disk) goes through the cloud download. A
    // still-uploading files-table row is "pending" too, but has a real on-disk
    // source and no `fileId`, so it stays on the local export path — local
    // downloads from the files table / recent files are unaffected.
    const pendingCloud = file.syncStatus === "pending" && !!file.fileId;
    const isCloudOnly = !file.source || pendingCloud;

    const { downloadDir } = await import("@tauri-apps/api/path");
    let saveDir: string | undefined;
    try {
      saveDir = await downloadDir();
    } catch {
      // Fall back to no directory hint
    }

    const filePath = await getFileSavePath(name, saveDir);
    if (!filePath) {
      toast.error("Download cancelled", { id: toastId });
      return;
    }

    toast.loading(`Exporting: ${name}`, { id: toastId });

    if (isCloudOnly) {
      if (!file.fileId || !file.label) {
        throw new Error("This file can't be downloaded from this device.");
      }
      // Downloads + decrypts the file straight to the chosen path.
      await invoke("download_remote_file", {
        accountId: polkadotAddress,
        label: file.label,
        fileId: file.fileId,
        outputPath: filePath,
      });
    } else {
      const info = await invoke<FilePathInfo>("resolve_file_info", {
        accountId: polkadotAddress,
        label: file.label ?? null,
        source: file.source ?? null,
        fileName: file.actualFileName || file.name,
      });
      await invoke("export_file", {
        syncPath: info.sync_path,
        fileName: info.relative_name,
        outputPath: filePath,
      });
    }

    toast.success(`Download complete: ${name}`, { id: toastId });
    return { success: true };
  } catch (err) {
    console.error("Download failed:", err);
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : ((err as { message?: string })?.message ?? String(err));
    toast.error(`Download failed: ${message}`, { id: toastId });
    return { success: false, error: "DOWNLOAD_FAILED", message };
  }
};

const downloadFolderExport = async (
  file: FormattedUserFile,
  polkadotAddress: string
) => {
  const { name } = file;
  const toastId = toast.loading(`Preparing folder download: ${name}`);

  try {
    const { downloadDir } = await import("@tauri-apps/api/path");
    let defaultPath: string | undefined;
    try {
      defaultPath = await downloadDir();
    } catch {
      // Fall back to no directory hint
    }
    const selectedDir = await open({
      directory: true,
      multiple: false,
      defaultPath,
    }) as string | null;

    if (!selectedDir) {
      toast.dismiss(toastId);
      return { success: false, error: "Download cancelled" };
    }

    const info = await invoke<FilePathInfo>("resolve_file_info", {
      accountId: polkadotAddress,
      label: file.label ?? null,
      source: file.source ?? null,
      fileName: file.actualFileName || file.name,
    });

    toast.loading(`Exporting folder: ${name}`, { id: toastId });

    await invoke("export_file", {
      syncPath: info.sync_path,
      fileName: info.relative_name,
      outputPath: await join(selectedDir, name),
    });

    toast.success(`Folder downloaded: ${name}`, { id: toastId });
    return { success: true };
  } catch (err) {
    toast.dismiss(toastId);
    console.error("Folder download failed:", err);
    toast.error(
      `Download failed: ${errorMessage(err)}`
    );
    return { success: false, error: "DOWNLOAD_FAILED", message: String(err) };
  }
};
