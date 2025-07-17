/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export default function IpfsTest() {
  const [file, setFile] = useState<File | null>(null);
  const [metadataCid, setMetadataCid] = useState<string>("");
  const [downloadedUrl, setDownloadedUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const accountId = polkadotAddress;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] || null);
  };

  const handleCreateEncryptionKey = async () => {
    setStatus("Creating encryption key...");
    try {
      await invoke("create_encryption_key");
      setStatus("Encryption key created successfully!");
    } catch (e: any) {
      setStatus("Failed to create encryption key: " + e.toString());
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setStatus("Uploading...");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const tempPath = `/tmp/${file.name}`;
      // Write file to disk using Rust command
      await invoke("write_file", {
        path: tempPath,
        data: Array.from(new Uint8Array(arrayBuffer)),
      });
      // Call the Rust erasure coding upload command
      const result = await invoke<string>("encrypt_and_upload_file", {
        accountId,
        filePath: tempPath,
        seedPhrase: mnemonic, // You'll need to provide the actual seed phrase
      });
      setMetadataCid(result);
      setStatus("Upload successful! Metadata CID: " + result);
    } catch (e: any) {
      setStatus("Upload failed: " + e.toString());
    }
  };

  const handleDownload = async () => {
    if (!metadataCid || !file) return;
    setStatus("Downloading...");
    try {
      const outputPath = `/tmp/dec_${file.name}`;
      await invoke("download_and_decrypt_file", {
        accountId,
        metadataCid,
        outputFile: outputPath,
      });
      // Read the file from disk using Rust command
      const data: number[] = await invoke("read_file", { path: outputPath });
      const blob = new Blob([new Uint8Array(data)]);
      const url = URL.createObjectURL(blob);
      setDownloadedUrl(url);
      setStatus("Download successful!");
    } catch (e: any) {
      setStatus("Download failed: " + e.toString());
    }
  };

  return (
    <div>
      <h2>IPFS Encrypted Upload/Download (Erasure Coding Test)</h2>
      <input type="file" onChange={handleFileChange} />
      <button onClick={handleCreateEncryptionKey}>
        Create Encryption Key
      </button>
      <button onClick={handleUpload} disabled={!file}>
        Upload & Encrypt
      </button>
      {metadataCid && (
        <>
          <div>
            <strong>Metadata CID:</strong> {metadataCid}
          </div>
          <button onClick={handleDownload}>Download & Decrypt</button>
        </>
      )}
      {downloadedUrl && (
        <div>
          <a href={downloadedUrl} download={file ? `dec_${file.name}` : "file"}>
            Download Decrypted File
          </a>
        </div>
      )}
      <div>{status}</div>
    </div>
  );
}
