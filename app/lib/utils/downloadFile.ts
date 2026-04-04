import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
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
    const info = await invoke<FilePathInfo>("resolve_file_info", {
      accountId: polkadotAddress,
      label: file.label ?? null,
      source: file.source ?? null,
      fileName: file.actualFileName || file.name,
    });

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

    await invoke("export_file", {
      syncPath: info.sync_path,
      fileName: info.relative_name,
      outputPath: filePath,
    });

    toast.success(`Download complete: ${name}`, { id: toastId });
    return { success: true };
  } catch (err) {
    console.error("Download failed:", err);
    toast.error(
      `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      { id: toastId }
    );
    return { success: false, error: "DOWNLOAD_FAILED", message: String(err) };
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
      `Download failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { success: false, error: "DOWNLOAD_FAILED", message: String(err) };
  }
};
