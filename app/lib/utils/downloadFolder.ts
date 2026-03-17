import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getPrivateSyncPath, getAllSyncPaths, getSyncFolderDefaultPath } from "@/lib/utils/syncPathUtils";

export interface DownloadIpfsFolderOptions {
    folderName: string;
    polkadotAddress: string;
    outputDir?: string | null;
    file?: FormattedUserFile;
}

export const downloadFolder = async ({
    folderName,
    polkadotAddress,
    outputDir,
    file,
}: DownloadIpfsFolderOptions) => {
    let selectedOutputDir = outputDir;
    if (!selectedOutputDir) {
        const defaultPath = await getSyncFolderDefaultPath(polkadotAddress);
        selectedOutputDir = (await open({
            directory: true,
            multiple: false,
            defaultPath,
        })) as string | null;
        if (!selectedOutputDir) {
            return { success: false, error: "Download cancelled" };
        }
    }

    const toastId = toast.info("Downloading folder...", { duration: Infinity });

    try {
        let syncPath: string;
        if (file?.label) {
            const allPaths = await getAllSyncPaths(polkadotAddress);
            const match = allPaths.find((sp) => sp.label === file.label);
            syncPath = match?.path ?? (await getPrivateSyncPath(polkadotAddress))?.path ?? "";
        } else {
            syncPath = (await getPrivateSyncPath(polkadotAddress))?.path ?? "";
        }
        const fileName = file?.source && syncPath
            ? (() => {
                const prefix = syncPath.endsWith("/") ? syncPath : syncPath + "/";
                return file.source!.startsWith(prefix)
                    ? file.source!.slice(prefix.length)
                    : (file?.actualFileName || folderName);
            })()
            : (file?.actualFileName || folderName);

        await invoke("export_file", {
            syncPath,
            fileName,
            outputPath: `${selectedOutputDir}/${folderName}`,
        });

        toast.dismiss(toastId);
        toast.success("Folder downloaded successfully!");
        return { success: true };
    } catch (error) {
        toast.dismiss(toastId);
        console.error("Folder download failed:", error);
        return {
            success: false,
            error: "DOWNLOAD_FAILED",
            message: error instanceof Error ? error.message : String(error),
        };
    }
};
