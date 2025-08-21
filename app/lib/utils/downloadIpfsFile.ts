import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { decodeHexCid } from "./decodeHexCid";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { downloadIpfsFolder } from "./downloadIpfsFolder";

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

const ensureWalletConnected = (polkadotAddress: string | undefined | null) => {
  if (!polkadotAddress) {
    throw new Error(
      "Wallet not connected. Please connect your wallet to download files."
    );
  }
};

export const downloadIpfsFile = async (
  file: FormattedUserIpfsFile,
  polkadotAddress: string,
  isPrivateView: boolean
) => {
  if (file.isFolder) {
    console.log("isFolder", file)
    const result = await downloadIpfsFolder({
      folderCid: file.cid,
      folderName: file.name,
      polkadotAddress,
      isPrivate: isPrivateView
    });

    if (result && !result.success) {
      toast.error(
        `Failed to download folder: ${result.message || "Unknown error"}`
      );
    }
    return;
  } else if (isPrivateView) {
    return downloadEncryptedIpfsFile(
      file,
      polkadotAddress ?? ""
    );
  } else {
    return downloadRegularIpfsFile(file);
  }
};

const downloadRegularIpfsFile = async (file: FormattedUserIpfsFile) => {
  const { cid, name } = file;
  const toastId = toast.loading(`Preparing download: ${name}`);

  try {
    const filePath = await getFileSavePath(name);

    if (!filePath) {
      toast.error("Download cancelled", { id: toastId });
      return;
    }

    toast.loading(`Downloading: ${name}`, { id: toastId });

    await invoke("download_file_public", {
      fileCid: decodeHexCid(cid),
      outputFile: filePath
    });

    toast.success(`Download complete: ${name}`, { id: toastId });
    return { success: true };
  } catch (err) {
    console.error("Download failed:", err);
    toast.error(
      `Download failed: ${err instanceof Error ? err.message : "Unknown error"
      }`,
      { id: toastId }
    );
    return { success: false, error: "DOWNLOAD_FAILED", message: String(err) };
  }
};

const downloadEncryptedIpfsFile = async (
  file: FormattedUserIpfsFile,
  polkadotAddress: string
) => {
  const { name, cid } = file;
  const toastId = toast.loading(`Preparing download: ${name}`);

  try {
    ensureWalletConnected(polkadotAddress);

    const savePath = await getFileSavePath(name);

    if (!savePath) {
      toast.dismiss(toastId);
      return { success: false, error: "Download cancelled" };
    }

    toast.loading(`Downloading encrypted file: ${name}...`, { id: toastId });

    await invoke("download_and_decrypt_file", {
      accountId: polkadotAddress,
      metadataCid: cid,
      outputFile: savePath
    });

    toast.success(`Download complete: ${name}`, {
      id: toastId
    });
    return { success: true };
  } catch (err) {
    toast.dismiss(toastId);
    const errorMsg = String(err);
    console.error("Encrypted download failed:", err);
    toast.error(
      `Download failed: ${err instanceof Error ? err.message : "Unknown error"
      }`
    );
    return { success: false, error: "DOWNLOAD_FAILED", message: errorMsg };
  }
};
