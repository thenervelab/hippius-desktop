"use client";
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function IpfsTest() {
  const [file, setFile] = useState<File | null>(null);
  const [cid, setCid] = useState<string>("");
  const [downloadedUrl, setDownloadedUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  // Replace with your actual account id and IPFS API URL
  const accountId = "test-account";
  const apiUrl = "http://127.0.0.1:5001";

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] || null);
  };

  const handleUpload = async () => {
    if (!file) return;
    setStatus("Uploading...");
    // Save file to a temp path (Tauri can only access files on disk)
    const arrayBuffer = await file.arrayBuffer();
    const tempPath = `/tmp/${file.name}`;
    // Write file to disk using Tauri's fs API
    await invoke("write_file", { path: tempPath, data: Array.from(new Uint8Array(arrayBuffer)) });
    // Call the Rust command
    try {
      const result = await invoke<string>("encrypt_and_upload_file", {
        accountId,
        filePath: tempPath,
        apiUrl,
      });
      setCid(result);
      setStatus("Upload successful! CID: " + result);
    } catch (e: any) {
      setStatus("Upload failed: " + e.toString());
    }
  };
  

  const handleDownload = async () => {
    if (!cid) return;
    setStatus("Downloading...");
    try {
      const data: number[] = await invoke("download_and_decrypt_file", {
        accountId,
        cid,
        apiUrl,
      });
      // Convert to Blob and create a download link
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
      <h2>IPFS Encrypted Upload/Download Test</h2>
      <input type="file" onChange={handleFileChange} />
      <button onClick={handleUpload} disabled={!file}>Upload & Encrypt</button>
      <br />
      {cid && (
        <>
          <div>
            <strong>CID:</strong> {cid}
          </div>
          <button onClick={handleDownload}>Download & Decrypt</button>
        </>
      )}
      {downloadedUrl && (
        <div>
          <a href={downloadedUrl} download="downloaded_file">
            Download Decrypted File
          </a>
        </div>
      )}
      <div>{status}</div>
    </div>
  );
}