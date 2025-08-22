import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
export interface DownloadIpfsFolderOptions {
    folderCid: string;
    folderName: string;
    polkadotAddress: string;
    isPrivate: boolean;
    encryptionKey?: string | null;
    outputDir?: string | null;
    file?: FormattedUserIpfsFile;
    source?: string | null
}

export const downloadIpfsFolder = async ({
    folderCid,
    folderName,
    polkadotAddress,
    isPrivate,
    encryptionKey,
    outputDir,
    file,
    source
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

    console.log("selectedOutputDir", selectedOutputDir)

    console.log({
        accountId: polkadotAddress,
        folderMetadataCid: folderCid,
        folderName: folderName,
        outputDir: selectedOutputDir,
        encryptionKey: encryptionKey,
        source: source ? source : file?.source || ""
    })

    const toastId = toast.info("Downloading folder...", { duration: Infinity });

    try {
        let result;
        if (isPrivate) {
            result = await invoke<{
                success: boolean;
                error?: string;
                message?: string;
            }>("download_and_decrypt_folder", {
                accountId: polkadotAddress,
                folderMetadataCid: folderCid,
                folderName: folderName,
                outputDir: selectedOutputDir,
                encryptionKey: encryptionKey,
                source: source ? source : file?.source || ""
            });
        } else {
            result = await invoke<{
                success: boolean;
                error?: string;
                message?: string;
            }>("public_download_folder", {
                accountId: polkadotAddress,
                folderMetadataCid: folderCid,
                folderName: folderName,
                outputDir: selectedOutputDir,
                source: source ? source : file?.source || ""
            });
        }

        toast.dismiss(toastId);

        if (result && !result.success) {
            return {
                success: false,
                error: result.error || "DOWNLOAD_FAILED",
                message: result.message || "Unknown error",
            };
        }

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