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
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

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

  const handleTransfer = async () => {
    setStatus("Transferring balance...");
    try {
      // Convert amount (string) to plancks (u128) with 18 decimals
      let planckAmount: string;
      if (!amount || isNaN(Number(amount))) {
        setStatus("Invalid amount");
        return;
      }
      // Support both integer and decimal input
      const [whole, fraction = ""] = amount.split(".");
      const fractionPadded = (fraction + "0".repeat(18)).slice(0, 18);
      planckAmount = whole + fractionPadded;
      // Remove leading zeros
      planckAmount = planckAmount.replace(/^0+/, "");
      if (!planckAmount) planckAmount = "0";

      const result = await invoke<string>("transfer_balance_tauri", {
        senderSeed: mnemonic,
        recipientAddress: recipient,
        amount: planckAmount, // send as string to avoid BigInt issues
      });
      setStatus("Transfer successful! " + result);
    } catch (e: any) {
      setStatus("Transfer failed: " + e.toString());
    }
  };

  return (
    <div>
      <h2>IPFS Encrypted Upload/Download (Erasure Coding Test)</h2>
      <input type="file" onChange={handleFileChange} />
      <button onClick={handleCreateEncryptionKey}>
        Create Encryption Key
      </button>
      <div style={{ margin: '8px 0' }}>
        <input
          type="text"
          placeholder="Recipient Address"
          value={recipient}
          onChange={e => setRecipient(e.target.value)}
          style={{ marginRight: 8 }}
        />
        <input
          type="number"
          placeholder="Amount (plancks)"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          style={{ marginRight: 8 }}
        />
        <button onClick={handleTransfer} disabled={!recipient || !amount}>
          Transfer Balance
        </button>
      </div>
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
