import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

interface FilePathInfo {
    sync_path: string;
    relative_name: string;
}

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
        const { downloadDir } = await import("@tauri-apps/api/path");
        let defaultPath: string | undefined;
        try {
            defaultPath = await downloadDir();
        } catch {
            // Fall back to no directory hint
        }
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
        const info = await invoke<FilePathInfo>("resolve_file_info", {
            accountId: polkadotAddress,
            label: file?.label ?? null,
            source: file?.source ?? null,
            fileName: file?.actualFileName || folderName,
        });

        await invoke("export_file", {
            syncPath: info.sync_path,
            fileName: info.relative_name,
            outputPath: await join(selectedOutputDir, folderName),
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
