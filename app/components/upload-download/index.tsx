/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWalletAuth } from "@/lib/wallet-auth-context";

export default function IpfsTest() {
  const [file, setFile] = useState<File | null>(null);
  const [metadataCid, setMetadataCid] = useState<string>("");
  const [publicCid, setPublicCid] = useState<string>("");
  const [downloadedUrl, setDownloadedUrl] = useState<string>("");
  const [publicDownloadedUrl, setPublicDownloadedUrl] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const { polkadotAddress, mnemonic } = useWalletAuth();
  const accountId = polkadotAddress;
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [encryptionKeys, setEncryptionKeys] = useState<Array<{ id: number, key: string }>>([]);
  const [publicErsMetadataCid, setPublicErsMetadataCid] = useState<string>("");
  const [publicErsDownloadedUrl, setPublicErsDownloadedUrl] = useState<string>("");

  useEffect(() => {
    fetchEncryptionKeys();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] || null);
    setMetadataCid("");
    setPublicCid("");
    setDownloadedUrl("");
    setPublicDownloadedUrl("");
  };

  // ENCRYPTED
  const handleUpload = async () => {
    if (!file) return;
    setStatus("Uploading (encrypted)...");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const tempPath = `/tmp/${file.name}`;
      await invoke("write_file", {
        path: tempPath,
        data: Array.from(new Uint8Array(arrayBuffer)),
      });
      const result = await invoke<string>("encrypt_and_upload_file", {
        accountId,
        filePath: tempPath,
        seedPhrase: mnemonic,
        encryptionKey: null,  // so it uses lated encryption key by default 
      });
      setMetadataCid(result);
      setStatus("Encrypted upload successful! Metadata CID: " + result);
    } catch (e: any) {
      setStatus("Encrypted upload failed: " + e.toString());
    }
  };

  const handleDownload = async () => {
    if (!metadataCid || !file) return;
    setStatus("Downloading (encrypted)...");
    try {
      const outputPath = `/tmp/dec_${file.name}`;
      await invoke("download_and_decrypt_file", {
        accountId,
        metadataCid,
        outputFile: outputPath,
        encryptionKey: null,  // so it uses lated encryption key by default 
      });
      const data: number[] = await invoke("read_file", { path: outputPath });
      const blob = new Blob([new Uint8Array(data)]);
      const url = URL.createObjectURL(blob);
      setDownloadedUrl(url);
      setStatus("Encrypted download successful!");
    } catch (e: any) {
      setStatus("Encrypted download failed: " + e.toString());
    }
  };

  // PUBLIC
  const handlePublicUpload = async () => {
    if (!file) return;
    setStatus("Uploading (public)...");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const tempPath = `/tmp/${file.name}`;
      await invoke("write_file", {
        path: tempPath,
        data: Array.from(new Uint8Array(arrayBuffer)),
      });
      const result = await invoke<string>("upload_file_public", {
        accountId,
        filePath: tempPath,
        seedPhrase: mnemonic,
      });
      setPublicCid(result);
      setStatus("Public upload successful! File CID: " + result);
    } catch (e: any) {
      setStatus("Public upload failed: " + e.toString());
    }
  };

  const handlePublicDownload = async () => {
    if (!publicCid || !file) return;
    setStatus("Downloading (public)...");
    try {
      const outputPath = `/tmp/pub_${file.name}`;
      await invoke("download_file_public", {
        fileCid: publicCid,
        outputFile: outputPath,
      });
      const data: number[] = await invoke("read_file", { path: outputPath });
      const blob = new Blob([new Uint8Array(data)]);
      const url = URL.createObjectURL(blob);
      setPublicDownloadedUrl(url);
      setStatus("Public download successful!");
    } catch (e: any) {
      setStatus("Public download failed: " + e.toString());
    }
  };

  // PUBLIC ERASURE-CODED
  const handlePublicErsUpload = async () => {
    if (!file) return;
    setStatus("Uploading (public erasure-coded)...");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const tempPath = `/tmp/${file.name}`;
      await invoke("write_file", {
        path: tempPath,
        data: Array.from(new Uint8Array(arrayBuffer)),
      });
      const result = await invoke<string>("public_upload_with_erasure", {
        accountId,
        filePath: tempPath,
        seedPhrase: mnemonic,
      });
      setPublicErsMetadataCid(result);
      setStatus("Public erasure-coded upload successful! Metadata CID: " + result);
    } catch (e: any) {
      setStatus("Public erasure-coded upload failed: " + e.toString());
    }
  };

  const handlePublicErsDownload = async () => {
    if (!publicErsMetadataCid || !file) return;
    setStatus("Downloading (public erasure-coded)...");
    try {
      const outputPath = `/tmp/pub_ers_${file.name}`;
      await invoke("public_download_with_erasure", {
        accountId,
        metadataCid: publicErsMetadataCid,
        outputFile: outputPath,
      });
      const data: number[] = await invoke("read_file", { path: outputPath });
      const blob = new Blob([new Uint8Array(data)]);
      const url = URL.createObjectURL(blob);
      setPublicErsDownloadedUrl(url);
      setStatus("Public erasure-coded download successful!");
    } catch (e: any) {
      setStatus("Public erasure-coded download failed: " + e.toString());
    }
  };

  // Transfer handler (unchanged)
  const handleTransfer = async () => {
    setStatus("Transferring balance...");
    try {
      let planckAmount: string;
      if (!amount || isNaN(Number(amount))) {
        setStatus("Invalid amount");
        return;
      }
      const [whole, fraction = ""] = amount.split(".");
      const fractionPadded = (fraction + "0".repeat(18)).slice(0, 18);
      planckAmount = whole + fractionPadded;
      planckAmount = planckAmount.replace(/^0+/, "");
      if (!planckAmount) planckAmount = "0";
      const result = await invoke<string>("transfer_balance_tauri", {
        senderSeed: mnemonic,
        recipientAddress: recipient,
        amount: planckAmount,
      });
      setStatus("Transfer successful! " + result);
    } catch (e: any) {
      setStatus("Transfer failed: " + e.toString());
    }
  };

  const fetchEncryptionKeys = async () => {
    try {
      const keys = await invoke<Array<{ id: number, key: string }>>("get_encryption_keys");
      setEncryptionKeys(keys);
      setStatus("Encryption keys fetched successfully");
    } catch (e: any) {
      setStatus("Failed to fetch encryption keys: " + e.toString());
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>IPFS Upload/Download Demo</h2>
      <input type="file" onChange={handleFileChange} style={{ marginBottom: 16 }} />
      <button
        onClick={async () => {
          setStatus("Creating encryption key...");
          try {
            await invoke("create_encryption_key");
            setStatus("Encryption key created successfully!");
            // Refresh the key list
            await fetchEncryptionKeys();
          } catch (e: any) {
            setStatus("Failed to create encryption key: " + e.toString());
          }
        }}
        style={{ marginBottom: 16 }}
      >
        Create Encryption Key
      </button>
      <div style={{ marginBottom: 24, padding: 16, border: "1px solid #ccc", borderRadius: 8 }}>
        <h3 style={{ marginTop: 0 }}>Encryption Keys</h3>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button
            onClick={async () => {
              setStatus("Creating encryption key...");
              try {
                await invoke("create_encryption_key");
                setStatus("Encryption key created successfully!");
                // Refresh the key list
                await fetchEncryptionKeys();
              } catch (e: any) {
                setStatus("Failed to create encryption key: " + e.toString());
              }
            }}
          >
            Create New Key
          </button>
          <button onClick={fetchEncryptionKeys}>
            Refresh Keys
          </button>
        </div>
        
        <div style={{ marginTop: 8 }}>
          {encryptionKeys.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {encryptionKeys.map(key => (
                <li key={key.id}>
                  <span style={{ wordBreak: "break-all" }}>{key.key}</span> (ID: {key.id})
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: 0, color: "#666" }}>No encryption keys found</p>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 24, marginBottom: 24 }}>
        {/* ENCRYPTED */}
        <div style={{ flex: 1, border: "1px solid #ccc", borderRadius: 8, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Encrypted Upload/Download</h3>
          <button onClick={handleUpload} disabled={!file} style={{ marginBottom: 8 }}>
            Upload & Encrypt
          </button>
          {metadataCid && (
            <>
              <div>
                <strong>Metadata CID:</strong> {metadataCid}
              </div>
              <button onClick={handleDownload} style={{ marginTop: 8 }}>
                Download & Decrypt
              </button>
            </>
          )}
          {downloadedUrl && (
            <div style={{ marginTop: 8 }}>
              <a href={downloadedUrl} download={file ? `dec_${file.name}` : "file"}>
                Download Decrypted File
              </a>
            </div>
          )}
        </div>
        {/* PUBLIC */}
        <div style={{ flex: 1, border: "1px solid #ccc", borderRadius: 8, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>Public Upload/Download</h3>
          <button onClick={handlePublicUpload} disabled={!file} style={{ marginBottom: 8 }}>
            Upload Public
          </button>
          {publicCid && (
            <>
              <div>
                <strong>File CID:</strong> {publicCid}
              </div>
              <button onClick={handlePublicDownload} style={{ marginTop: 8 }}>
                Download Public
              </button>
            </>
          )}
          {publicDownloadedUrl && (
            <div style={{ marginTop: 8 }}>
              <a href={publicDownloadedUrl} download={file ? `pub_${file.name}` : "file"}>
                Download Public File
              </a>
            </div>
          )}
        </div>
      </div>
      {/* PUBLIC ERASURE-CODED */}
      <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, marginBottom: 24 }}>
        <h3 style={{ marginTop: 0 }}>Public Erasure-Coded Upload/Download</h3>
        <button onClick={handlePublicErsUpload} disabled={!file} style={{ marginBottom: 8 }}>
          Upload Public (Erasure-Coded)
        </button>
        {publicErsMetadataCid && (
          <>
            <div>
              <strong>Metadata CID:</strong> {publicErsMetadataCid}
            </div>
            <button onClick={handlePublicErsDownload} style={{ marginTop: 8 }}>
              Download Public (Erasure-Coded)
            </button>
          </>
        )}
        {publicErsDownloadedUrl && (
          <div style={{ marginTop: 8 }}>
            <a href={publicErsDownloadedUrl} download={file ? `pub_ers_${file.name}` : "file"}>
              Download Public Erasure-Coded File
            </a>
          </div>
        )}
      </div>
      {/* Transfer section */}
      <div style={{ margin: "16px 0", padding: 16, border: "1px solid #eee", borderRadius: 8 }}>
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            placeholder="Recipient Address"
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
            style={{ marginRight: 8, width: 220 }}
          />
          <input
            type="number"
            placeholder="Amount (plancks)"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            style={{ marginRight: 8, width: 140 }}
          />
          <button onClick={handleTransfer} disabled={!recipient || !amount}>
            Transfer Balance
          </button>
        </div>
      </div>
      <div style={{ marginTop: 16, color: "#555" }}>{status}</div>
    </div>
  );
}