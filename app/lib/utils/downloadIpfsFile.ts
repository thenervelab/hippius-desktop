import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "./decodeHexCid";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

export const downloadIpfsFile = async (file: FormattedUserIpfsFile, polkadotAddress: string) => {
    const { source } = file;

    // Check if the file is from Hippius or another source
    if (source !== "Hippius") {
        // Encrypted download for files from other sources
        return downloadEncryptedIpfsFile(file, polkadotAddress ?? "");
    } else {
        // Regular IPFS download for Hippius files
        return downloadRegularIpfsFile(file);
    }
};

const downloadRegularIpfsFile = async (file: FormattedUserIpfsFile) => {
    const { cid, name } = file;

    const toastId = toast.loading(`Preparing download: ${name}`);

    try {
        // Get file extension to apply proper filter
        const fileExtension = name.split('.').pop() || '';

        // Show save dialog to ask user where to save the file
        const filePath = await save({
            filters: [{
                name: fileExtension ? `${fileExtension.toUpperCase()} File` : 'All Files',
                extensions: [fileExtension || '*']
            }],
            defaultPath: name
        });

        if (!filePath) {
            // User cancelled the dialog
            toast.error("Download cancelled", { id: toastId });
            return;
        }

        toast.loading(`Downloading: ${name}`, { id: toastId });

        const url = `https://get.hippius.network/ipfs/${decodeHexCid(cid)}?download=1`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(response.statusText);

        // Use arrayBuffer for more reliable binary data handling
        const arrayBuffer = await response.arrayBuffer();

        // Convert to Uint8Array for writing to file
        const fileData = new Uint8Array(arrayBuffer);

        // Write the file to the selected location using the correct Tauri API
        await writeFile(filePath, fileData);

        toast.success(`Download complete: ${name}`, { id: toastId });
    } catch (err) {
        console.error("Download failed:", err);
        toast.error(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`, { id: toastId });
    }
};

const downloadEncryptedIpfsFile = async (file: FormattedUserIpfsFile, polkadotAddress: string) => {
    const { name, cid } = file;

    const toastId = toast.loading(`Preparing download: ${name}`);

    try {

        if (!polkadotAddress) {
            throw new Error("Wallet not connected. Please connect your wallet to download encrypted files.");
        }

        const fileExtension = name.split('.').pop() || '';
        const savePath = await save({
            filters: [{
                name: fileExtension ? `${fileExtension.toUpperCase()} File` : 'All Files',
                extensions: [fileExtension || '*']
            }],
            defaultPath: name
        });

        if (!savePath) {
            toast.error("Download cancelled", { id: toastId });
            return;
        }

        toast.loading(`Downloading encrypted file: ${name}...`, { id: toastId });

        console.log({
            accountId: polkadotAddress,
            metadataCid: cid,
            outputFile: savePath
        })

        // Use the metadataCid (which is the cid in hex form) to download and decrypt the file
        await invoke("download_and_decrypt_file", {
            accountId: polkadotAddress,
            metadataCid: cid,
            outputFile: savePath
        });

        toast.success(`Download complete: ${name}`, { id: toastId });
    } catch (err) {
        console.error("Encrypted download failed:", err);
        toast.error(`Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`, { id: toastId });
    }
};
