import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "./decodeHexCid";
import { toast } from "sonner";
import { writeFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export const downloadIpfsFile = async (file: FormattedUserIpfsFile) => {
    const { cid, name } = file;
    const toastId = toast.loading(`Starting download: ${name}`);

    try {
        // Properly decode the CID
        const decodedCid = decodeHexCid(cid);
        const url = `https://get.hippius.network/ipfs/${decodedCid}?download=1`;

        console.log(`Downloading from: ${url}`);

        // Call our Tauri command to download the file
        // This will handle binary data properly in Rust
        const fileData = await invoke<number[]>("download_file", { url });

        if (!fileData || fileData.length === 0) {
            throw new Error("Received empty file data");
        }

        console.log(`Downloaded file size: ${fileData.length} bytes`);

        // Convert the number array to Uint8Array
        const binaryData = new Uint8Array(fileData);

        // Show save dialog - use the same approach as exportWalletAsZip
        const filePath = await save({
            defaultPath: name
        });

        if (filePath) {
            // Write the file using Tauri's FS API
            await writeFile(filePath, binaryData);

            console.log(`File saved to: ${filePath}`);
            toast.success(`Download complete: ${name} (${formatFileSize(binaryData.length)})`, { id: toastId });
            return true;
        } else {
            toast.error(`Download cancelled`, { id: toastId });
            return false;
        }
    } catch (err) {
        console.error("Download failed:", err);
        toast.error(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`, { id: toastId });
        return false;
    }
};

// Helper function to format file size
function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export const streamIpfsFile = async (file: FormattedUserIpfsFile) => {
    return downloadIpfsFile(file);
};
