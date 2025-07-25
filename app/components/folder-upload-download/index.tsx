"use client";
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

// Define the FileEntry type to match backend
interface FileEntry {
  file_name: string;
  manifestCid: string;
  file_size: number;
  cid: string;
}

export default function IpfsFolderDemo() {
  const [folderPath, setFolderPath] = useState<string>("");
  const [filePath, setFilePath] = useState<string>(""); // State for file to add
  const [fileToRemove, setFileToRemove] = useState<string>(""); // State for file to remove
  const [manifestCid, setManifestCid] = useState<string>("");
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [downloadStatus, setDownloadStatus] = useState<string>("");
  const [addFileStatus, setAddFileStatus] = useState<string>("");
  const [removeFileStatus, setRemoveFileStatus] = useState<string>("");
  const [isPrivateFolder, setIsPrivateFolder] = useState<boolean>(false); // Toggle for public/private folder
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
        setAddFileStatus("");
        setRemoveFileStatus("");
      } else {
        console.warn("⚠️ Folder selection was empty or cancelled.");
        setUploadStatus("Folder selection was empty or cancelled.");
      }
    } catch (e: unknown) {
      console.error("❌ Error selecting folder:", e);
      setUploadStatus("Failed to select folder: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Select a file to add to the folder
  const handleSelectFile = async () => {
    try {
      const selected: string | null = await open({
        directory: false,
        multiple: false,
      }) as string | null;

      if (typeof selected === "string" && selected.trim() !== "") {
        const sanitizedPath = selected.trim();
        console.log("✅ Selected file path:", sanitizedPath);
        setFilePath(sanitizedPath);
        setAddFileStatus("");
        setRemoveFileStatus("");
      } else {
        console.warn("⚠️ File selection was empty or cancelled.");
        setAddFileStatus("File selection was empty or cancelled.");
      }
    } catch (e: unknown) {
      console.error("❌ Error selecting file:", e);
      setAddFileStatus("Failed to select file: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Upload the folder (public or private)
  const handleUploadFolder = async () => {
    if (!folderPath) {
      setUploadStatus("No folder selected.");
      return;
    }

    console.log("⏫ Uploading folder:", folderPath);
    setUploadStatus(`Uploading ${isPrivateFolder ? "private" : "public"} folder...`);

    try {
      const command = isPrivateFolder ? "encrypt_and_upload_folder" : "public_upload_folder";
      const params = isPrivateFolder
        ? { accountId, folderPath, seedPhrase, encryptionKey: null }
        : { accountId, folderPath, seedPhrase };

      const result = await invoke<string>(command, params);

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
      const folderName = folderPath.split("/").pop() || "uploaded_folder";
      const files = await invoke<FileEntry[]>("list_folder_contents", {
        folderMetadataCid: manifestCid,
        folderName,
      });

      setFileList(files);
      setUploadStatus("Listed files successfully.");
    } catch (e: unknown) {
      console.error("❌ List files failed:", e);
      setUploadStatus("List failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Add a file to the folder (public or private)
  const handleAddFile = async () => {
    if (!manifestCid) {
      setAddFileStatus("No manifest CID available.");
      return;
    }
    if (!filePath) {
      setAddFileStatus("No file selected.");
      return;
    }

    console.log("⏫ Adding file:", filePath);
    setAddFileStatus(`Adding file to ${isPrivateFolder ? "private" : "public"} folder...`);

    try {
      const folderName = folderPath.split("/").pop() || "uploaded_folder";
      const command = isPrivateFolder ? "add_file_to_private_folder" : "add_file_to_public_folder";
      const params = isPrivateFolder
        ? { accountId, folderMetadataCid: manifestCid, folderName, filePath, seedPhrase, encryptionKey: null }
        : { accountId, folderMetadataCid: manifestCid, folderName, filePath, seedPhrase };

      const result = await invoke<string>(command, params);

      console.log("✅ File added. New Manifest CID:", result);
      setManifestCid(result);
      setAddFileStatus(`File added successfully! New Manifest CID: ${result}`);
      setFilePath(""); // Clear file path after successful add
      await handleListFiles(); // Refresh file list
    } catch (e: unknown) {
      console.error("❌ Add file failed:", e);
      setAddFileStatus("Add file failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Remove a file from the folder (public or private)
  const handleRemoveFile = async () => {
    if (!manifestCid) {
      setRemoveFileStatus("No manifest CID available.");
      return;
    }
    if (!fileToRemove) {
      setRemoveFileStatus("No file selected for removal.");
      return;
    }

    console.log("🗑️ Removing file:", fileToRemove);
    setRemoveFileStatus(`Removing file from ${isPrivateFolder ? "private" : "public"} folder...`);

    try {
      const folderName = folderPath.split("/").pop() || "uploaded_folder";
      const command = isPrivateFolder ? "remove_file_from_private_folder" : "remove_file_from_public_folder";
      const params = { accountId, folderMetadataCid: manifestCid, folderName, fileName: fileToRemove, seedPhrase };

      console.log("params", params)

      const result = await invoke<string>(command, params);

      console.log("✅ File removed. New Manifest CID:", result);
      setManifestCid(result);
      setRemoveFileStatus(`File removed successfully! New Manifest CID: ${result}`);
      setFileToRemove(""); // Clear selection after successful remove
      await handleListFiles(); // Refresh file list
    } catch (e: unknown) {
      console.error("❌ Remove file failed:", e);
      setRemoveFileStatus("Remove file failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Download the folder (public or private)
  const handleDownloadFolder = async () => {
    if (!manifestCid) {
      setDownloadStatus("No manifest CID available.");
      return;
    }

    setDownloadStatus(`Downloading ${isPrivateFolder ? "private" : "public"} folder...`);
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

      const command = isPrivateFolder ? "download_and_decrypt_folder" : "public_download_folder";
      const params = isPrivateFolder
        ? { accountId, folderMetadataCid: manifestCid, folderName: folderPath.split("/").pop() || "uploaded_folder", outputDir: sanitizedOutputDir, encryptionKey: null }
        : { accountId, folderMetadataCid: manifestCid, folderName: folderPath.split("/").pop() || "uploaded_folder", outputDir: sanitizedOutputDir };

      await invoke(command, params);

      setDownloadStatus("Download successful!");
    } catch (e: unknown) {
      console.error("❌ Download failed:", e);
      setDownloadStatus("Download failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">IPFS Folder Demo</h2>

      <div className="mb-6">
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={isPrivateFolder}
            onChange={(e) => setIsPrivateFolder(e.target.checked)}
            className="form-checkbox h-5 w-5 text-blue-600"
          />
          <span>Use Private Folder (No Encryption)</span>
        </label>
        <button
          onClick={handleSelectFolder}
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition"
        >
          Select Folder
        </button>
        {folderPath && (
          <div className="mt-2 text-gray-700">📁 Selected folder: {folderPath}</div>
        )}
      </div>

      <div className="mb-6">
        <button
          onClick={handleUploadFolder}
          disabled={!folderPath}
          className={`px-4 py-2 rounded transition ${folderPath
              ? "bg-green-500 text-white hover:bg-green-600"
              : "bg-gray-300 text-gray-600 cursor-not-allowed"
            }`}
        >
          Upload Folder ({isPrivateFolder ? "Private" : "Public"})
        </button>
        {uploadStatus && (
          <div className="mt-2 text-blue-600">{uploadStatus}</div>
        )}
      </div>

      {manifestCid && (
        <div className="mb-6">
          <div className="mb-2">
            <strong>📦 Manifest CID:</strong> {manifestCid}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleListFiles}
              className="bg-purple-500 text-white px-4 py-2 rounded hover:bg-purple-600 transition"
            >
              List Files in Folder
            </button>
            <button
              onClick={handleDownloadFolder}
              className="bg-orange-500 text-white px-4 py-2 rounded hover:bg-orange-600 transition"
            >
              Download Folder ({isPrivateFolder ? "Private" : "Public"})
            </button>
          </div>
          {downloadStatus && (
            <div className="mt-2 text-green-600">{downloadStatus}</div>
          )}
        </div>
      )}

      {manifestCid && (
        <div className="mb-6">
          <h4 className="text-lg font-semibold mb-2">Add File to Folder</h4>
          <div className="flex gap-2 items-center">
            <button
              onClick={handleSelectFile}
              className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 transition"
            >
              Select File to Add
            </button>
            {filePath && (
              <span className="text-gray-700">📄 Selected: {filePath.split("/").pop()}</span>
            )}
          </div>
          <button
            onClick={handleAddFile}
            disabled={!filePath || !manifestCid}
            className={`mt-2 px-4 py-2 rounded transition ${filePath && manifestCid
                ? "bg-green-500 text-white hover:bg-green-600"
                : "bg-gray-300 text-gray-600 cursor-not-allowed"
              }`}
          >
            Add File to Folder ({isPrivateFolder ? "Private" : "Public"})
          </button>
          {addFileStatus && (
            <div className="mt-2 text-blue-600">{addFileStatus}</div>
          )}
        </div>
      )}

      {fileList.length > 0 && (
        <div className="mb-6">
          <h4 className="text-lg font-semibold mb-2">Remove File from Folder</h4>
          <select
            value={fileToRemove}
            onChange={(e) => setFileToRemove(e.target.value)}
            className="border rounded px-2 py-1 mb-2 w-full max-w-md"
          >
            <option value="">Select a file to remove</option>
            {fileList.map((f, i) => (
              <option key={i} value={f.file_name}>
                {f.file_name}
              </option>
            ))}
          </select>
          <button
            onClick={handleRemoveFile}
            disabled={!fileToRemove || !manifestCid}
            className={`px-4 py-2 rounded transition ${fileToRemove && manifestCid
                ? "bg-red-500 text-white hover:bg-red-600"
                : "bg-gray-300 text-gray-600 cursor-not-allowed"
              }`}
          >
            Remove File from Folder ({isPrivateFolder ? "Private" : "Public"})
          </button>
          {removeFileStatus && (
            <div className="mt-2 text-red-600">{removeFileStatus}</div>
          )}
        </div>
      )}

      {fileList.length > 0 && (
        <div className="mb-6">
          <h4 className="text-lg font-semibold mb-2">📜 Files in Folder:</h4>
          <ul className="list-disc pl-5">
            {fileList.map((f, i) => (
              <li key={i} className="my-1">
                {f.file_name} ({f.file_size} bytes) - CID: {f.cid}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}