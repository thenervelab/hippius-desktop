import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { open } from "@tauri-apps/plugin-dialog";

const getFileSavePath = async (name: string) => {
  const fileExtension = name.split(".").pop() || "";
  return await save({
    filters: [
      {
        name: fileExtension
          ? `${fileExtension.toUpperCase()} File`
          : "All Files",
        extensions: [fileExtension || "*"]
      }
    ],
    defaultPath: name
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
    // Get sync path
    const syncPathResult = await invoke<{ path: string; is_public: boolean }>(
      "get_sync_path",
      { isPublic: true, accountId: polkadotAddress }
    );
    const syncPath = syncPathResult.path;

    const filePath = await getFileSavePath(name);
    if (!filePath) {
      toast.error("Download cancelled", { id: toastId });
      return;
    }

    toast.loading(`Exporting: ${name}`, { id: toastId });

    await invoke("export_file", {
      syncPath,
      fileName: file.actualFileName || name,
      outputPath: filePath,
    });

    toast.success(`Download complete: ${name}`, { id: toastId });
    return { success: true };
  } catch (err) {
    console.error("Download failed:", err);
    toast.error(
      `Download failed: ${err instanceof Error ? err.message : "Unknown error"}`,
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
    const selectedDir = await open({
      directory: true,
      multiple: false,
    }) as string | null;

    if (!selectedDir) {
      toast.dismiss(toastId);
      return { success: false, error: "Download cancelled" };
    }

    // Get sync path
    const syncPathResult = await invoke<{ path: string; is_public: boolean }>(
      "get_sync_path",
      { isPublic: true, accountId: polkadotAddress }
    );
    const syncPath = syncPathResult.path;

    toast.loading(`Exporting folder: ${name}`, { id: toastId });

    // Export the folder by listing and copying contents
    await invoke("export_file", {
      syncPath,
      fileName: file.actualFileName || name,
      outputPath: `${selectedDir}/${name}`,
    });

    toast.success(`Folder downloaded: ${name}`, { id: toastId });
    return { success: true };
  } catch (err) {
    toast.dismiss(toastId);
    console.error("Folder download failed:", err);
    toast.error(
      `Download failed: ${err instanceof Error ? err.message : "Unknown error"}`
    );
    return { success: false, error: "DOWNLOAD_FAILED", message: String(err) };
  }
};
