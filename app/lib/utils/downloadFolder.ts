import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

export interface DownloadIpfsFolderOptions {
    folderCid: string;
    folderName: string;
    polkadotAddress: string;
    isPrivate: boolean;
    encryptionKey?: string | null;
    outputDir?: string | null;
    file?: FormattedUserFile;
    source?: string | null;
    mainReqHash?: string | null;
}

export const downloadFolder = async ({
    folderName,
    polkadotAddress,
    outputDir,
    file,
}: DownloadIpfsFolderOptions) => {
    let selectedOutputDir = outputDir;
    if (!selectedOutputDir) {
        selectedOutputDir = (await open({
            directory: true,
            multiple: false,
        })) as string | null;
        if (!selectedOutputDir) {
            return { success: false, error: "Download cancelled" };
        }
    }

    const toastId = toast.info("Downloading folder...", { duration: Infinity });

    try {
        // Get sync path
        const syncPathResult = await invoke<{ path: string; is_public: boolean }>(
            "get_sync_path",
            { isPublic: true, accountId: polkadotAddress }
        );
        const syncPath = syncPathResult.path;

        const fileName = file?.actualFileName || folderName;

        // Export folder from sync folder to chosen location
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
        console.log("Download failed:", error);
        return {
            success: false,
            error: "DOWNLOAD_FAILED",
            message: error instanceof Error ? error.message : String(error),
        };
    }
};
