"use client";
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

// Define the FileEntry type to match backend
interface FileEntry {
  file_name: string;
  file_size: number;
  cid: string;
}

export default function IpfsFolderDemo() {
  const [folderPath, setFolderPath] = useState<string>("");
  const [manifestCid, setManifestCid] = useState<string>("");
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [downloadStatus, setDownloadStatus] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [useEncryption, setUseEncryption] = useState<boolean>(true); // Toggle for encrypted vs public
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const accountId = polkadotAddress;
  const seedPhrase = mnemonic;

  // Select a folder using Tauri dialog
  const handleSelectFolder = async () => {
    try {
      const selected: string | null = await open({
        directory: true,
        multiple: false,
      }) as string | null;

      if (typeof selected === "string" && selected.trim() !== "") {
        const sanitizedPath = selected.trim();
        console.log("✅ Selected folder path:", sanitizedPath);
        setFolderPath(sanitizedPath);
        setFileList([]);
        setManifestCid("");
        setUploadStatus("");
        setDownloadStatus("");
      } else {
        console.warn("⚠️ Folder selection was empty or cancelled.");
      }
    } catch (e: unknown) {
      console.error("❌ Error selecting folder:", e);
      setUploadStatus("Failed to select folder: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Upload the folder
  const handleUploadFolder = async () => {
    if (!folderPath) {
      setUploadStatus("No folder selected.");
      return;
    }

    console.log("⏫ Uploading folder:", folderPath);
    setUploadStatus("Uploading folder...");

    try {
      const command = useEncryption ? "encrypt_and_upload_folder" : "public_upload_folder";
      const result = await invoke<string>(command, {
        accountId,
        folderPath,
        seedPhrase,
        ...(useEncryption ? { encryptionKey: null } : {}), // Only include encryptionKey for encrypted upload
      });

      console.log("✅ Upload complete. Manifest CID:", result);
      setManifestCid(result);
      setUploadStatus(`Upload successful! Manifest CID: ${result}`);
    } catch (e: unknown) {
      console.error("❌ Upload failed:", e);
      setUploadStatus("Upload failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // List files in the uploaded folder
  const handleListFiles = async () => {
    if (!manifestCid) {
      setUploadStatus("No manifest CID available.");
      return;
    }

    setUploadStatus("Listing files...");

    try {
      const files = await invoke<FileEntry[]>("list_folder_contents", {
        folderMetadataCid: manifestCid,
      });

      setFileList(files);
      setUploadStatus("Listed files successfully.");
    } catch (e: unknown) {
      console.error("❌ List files failed:", e);
      setUploadStatus("List failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Download the folder
  const handleDownloadFolder = async () => {
    if (!manifestCid) {
      setDownloadStatus("No manifest CID available.");
      return;
    }

    setDownloadStatus("Downloading folder...");
    try {
      const outputDir: string | null = await open({
        directory: true,
        multiple: false,
      }) as string | null;

      if (!outputDir || typeof outputDir !== "string") {
        setDownloadStatus("No output directory selected.");
        return;
      }

      const sanitizedOutputDir = outputDir.trim();
      console.log("📥 Downloading to:", sanitizedOutputDir);

      const command = useEncryption ? "download_and_decrypt_folder" : "public_download_folder";
      await invoke(command, {
        accountId,
        folderMetadataCid: manifestCid,
        folderName: "faiz",
        outputDir: sanitizedOutputDir,
        ...(useEncryption ? { encryptionKey: null } : {}), // Only include encryptionKey for encrypted download
      });

      setDownloadStatus("Download successful!");
    } catch (e: unknown) {
      console.error("❌ Download failed:", e);
      setDownloadStatus("Download failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Toggle between encrypted and public upload/download
  const handleToggleEncryption = () => {
    setUseEncryption(!useEncryption);
    setUploadStatus("");
    setDownloadStatus("");
    setFileList([]);
    setManifestCid("");
  };

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">IPFS Folder Upload/Download Demo</h2>

      <div className="mb-4">
        <label className="inline-flex items-center">
          <input
            type="checkbox"
            checked={useEncryption}
            onChange={handleToggleEncryption}
            className="mr-2"
          />
          Use Encryption
        </label>
      </div>

      <button
        onClick={handleSelectFolder}
        className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 mb-4"
      >
        Select Folder
      </button>

      {folderPath && (
        <div className="mb-4">📁 Selected folder: {folderPath}</div>
      )}

      <button
        onClick={handleUploadFolder}
        disabled={!folderPath}
        className={`px-4 py-2 rounded mb-4 ${folderPath
            ? "bg-green-500 text-white hover:bg-green-600"
            : "bg-gray-300 text-gray-600 cursor-not-allowed"
          }`}
      >
        {useEncryption ? "Upload & Encrypt Folder" : "Upload Folder (Public)"}
      </button>

      {manifestCid && (
        <div className="mb-4">
          <div className="mb-2">
            <strong>📦 Manifest CID:</strong> {manifestCid}
          </div>
          <button
            onClick={handleListFiles}
            className="bg-purple-500 text-white px-4 py-2 rounded hover:bg-purple-600 mr-2"
          >
            List Files in Folder
          </button>
          <button
            onClick={handleDownloadFolder}
            className="bg-orange-500 text-white px-4 py-2 rounded hover:bg-orange-600"
          >
            {useEncryption ? "Download & Decrypt Folder" : "Download Folder (Public)"}
          </button>
        </div>
      )}

      {fileList.length > 0 && (
        <div className="mb-4">
          <h4 className="text-lg font-semibold">📜 Files in Folder:</h4>
          <ul className="list-disc pl-5">
            {fileList.map((f, i) => (
              <li key={i} className="my-1">
                {f.file_name} ({f.file_size} bytes) - CID: {f.cid}
              </li>
            ))}
          </ul>
        </div>
      )}

      {uploadStatus && (
        <div className="text-blue-600 mb-2">{uploadStatus}</div>
      )}
      {downloadStatus && (
        <div className="text-green-600">{downloadStatus}</div>
      )}
    </div>
  );
}