import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { getPrivateSyncPath, getAllSyncPaths } from "@/lib/utils/syncPathUtils";

async function resolveSyncPath(
  file: FormattedUserFile,
  polkadotAddress: string
): Promise<string> {
  if (file.label) {
    const allPaths = await getAllSyncPaths(polkadotAddress);
    const match = allPaths.find((sp) => sp.label === file.label);
    if (match?.path) return match.path;
  }
  return (await getPrivateSyncPath(polkadotAddress))?.path ?? "";
}

/**
 * Derive the file name relative to the sync root.
 * Prefers computing from `file.source` (full filesystem path) so that
 * files / folders inside subfolders resolve correctly even when
 * `actualFileName` only contains the basename.
 */
function resolveRelativeName(
  file: FormattedUserFile,
  syncPath: string,
): string {
  if (file.source && syncPath) {
    const prefix = syncPath.endsWith("/") ? syncPath : syncPath + "/";
    if (file.source.startsWith(prefix)) {
      return file.source.slice(prefix.length);
    }
  }
  return file.actualFileName || file.name;
}

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
    const syncPath = await resolveSyncPath(file, polkadotAddress);

    const filePath = await getFileSavePath(name);
    if (!filePath) {
      toast.error("Download cancelled", { id: toastId });
      return;
    }

    toast.loading(`Exporting: ${name}`, { id: toastId });

    const fileName = resolveRelativeName(file, syncPath);
    await invoke("export_file", {
      syncPath,
      fileName,
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
    const { getSyncFolderDefaultPath } = await import("@/lib/utils/syncPathUtils");
    const defaultPath = await getSyncFolderDefaultPath(polkadotAddress);
    const selectedDir = await open({
      directory: true,
      multiple: false,
      defaultPath,
    }) as string | null;

    if (!selectedDir) {
      toast.dismiss(toastId);
      return { success: false, error: "Download cancelled" };
    }

    const syncPath = await resolveSyncPath(file, polkadotAddress);

    toast.loading(`Exporting folder: ${name}`, { id: toastId });

    const fileName = resolveRelativeName(file, syncPath);
    await invoke("export_file", {
      syncPath,
      fileName,
      outputPath: `${selectedDir}/${name}`,
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
