/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function DirectStorageRequestDemo({ 
  seedPhrase, 
  accountId 
}: { 
  seedPhrase: string; 
  accountId: string 
}) {
  const [file, setFile] = useState<File | null>(null);
  const [metadataCid, setMetadataCid] = useState<string>("");
  const [downloadedUrl, setDownloadedUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("");


  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] || null);
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
        accountId: accountId,
        filePath: tempPath,
        seedPhrase: seedPhrase,
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
        accountId: accountId,
        metadataCid: metadataCid,
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
