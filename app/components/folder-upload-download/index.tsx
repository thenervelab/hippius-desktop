/* eslint-disable @typescript-eslint/no-explicit-any */

"use client";
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export default function IpfsFolderDemo() {
  const [folderPath, setFolderPath] = useState<string>("");
  const [manifestCid, setManifestCid] = useState<string>("");
  const [fileList, setFileList] = useState<any[]>([]);
  const [downloadStatus, setDownloadStatus] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const accountId = polkadotAddress;
  const seedPhrase = mnemonic;

  // Select a folder using Tauri dialog
  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (typeof selected === "string" && selected.trim() !== "") {
        const sanitizedPath = selected.trim();
        console.log("✅ Selected folder path:", sanitizedPath);
        setFolderPath(sanitizedPath);
        setFileList([]);
        setManifestCid("");
      } else {
        console.warn("⚠️ Folder selection was empty or cancelled.");
      }
    } catch (e: any) {
      console.error("❌ Error selecting folder:", e);
      setUploadStatus("Failed to select folder: " + e.toString());
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
      const result = await invoke<string>("encrypt_and_upload_folder", {
        accountId,
        folderPath,
        seedPhrase,
        encryptionKey: null, // so it uses lated encryption key by default 
      });

      console.log("✅ Upload complete. Manifest CID:", result);
      setManifestCid(result);
      setUploadStatus("Upload successful! Manifest CID: " + result);
    } catch (e: any) {
      console.error("❌ Upload failed:", e);
      setUploadStatus("Upload failed: " + e.toString());
    }
  };

  // List files in the uploaded folder
  const handleListFiles = async () => {
    if (!manifestCid) return;
    setUploadStatus("Listing files...");

    try {
      const files = await invoke<any[]>("list_folder_contents", {
        folderMetadataCid: manifestCid,
      });

      setFileList(files);
      setUploadStatus("Listed files successfully.");
    } catch (e: any) {
      console.error("❌ List files failed:", e);
      setUploadStatus("List failed: " + e.toString());
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
      const outputDir = await open({
        directory: true,
        multiple: false,
      });

      if (!outputDir || typeof outputDir !== "string") {
        setDownloadStatus("No output directory selected.");
        return;
      }

      const sanitizedOutputDir = outputDir.trim();
      console.log("📥 Downloading to:", sanitizedOutputDir);

      await invoke("download_and_decrypt_folder", {
        accountId,
        folderMetadataCid: manifestCid,
        folderName: "faiz",
        outputDir: sanitizedOutputDir,
        encryptionKey: null, // so it uses lated encryption key by default 
      });

      setDownloadStatus("Download successful!");
    } catch (e: any) {
      console.error("❌ Download failed:", e);
      setDownloadStatus("Download failed: " + e.toString());
    }
  };

  return (
    <div>
      <h2>IPFS Encrypted Folder Upload/Download Demo</h2>

      <button onClick={handleSelectFolder}>Select Folder</button>

      {folderPath && <div>📁 Selected folder: {folderPath}</div>}

      <button onClick={handleUploadFolder} disabled={!folderPath}>
        Upload & Encrypt Folder
      </button>

      {manifestCid && (
        <>
          <div>
            <strong>📦 Manifest CID:</strong> {manifestCid}
          </div>

          <button onClick={handleListFiles}>List Files in Folder</button>
          <button onClick={handleDownloadFolder}>Download & Decrypt Folder</button>
        </>
      )}
      {/* <button onClick={handleListFiles}>List Files in Folder</button> */}

      {fileList.length > 0 && (
        <div>
          <h4>📜 Files in Folder:</h4>
          <ul>
            {fileList.map((f, i) => (
              <li key={i}>
                {f.file_name} ({f.file_size} bytes) - CID: {f.cid}
              </li>
            ))}
          </ul>
        </div>
      )}

      {uploadStatus && <div style={{ color: "blue" }}>{uploadStatus}</div>}
      {downloadStatus && <div style={{ color: "green" }}>{downloadStatus}</div>}
    </div>
  );
}