// app/components/DemoIpfsUpload.tsx
import React, { useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

async function uploadToIpfs(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("http://localhost:5001/api/v0/add", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`IPFS upload failed: ${response.statusText}`);
  }

  // The response is NDJSON (newline-delimited JSON), but for a single file, it's just one line
  const text = await response.text();
  // Each line is a JSON object; for a single file, just parse the first line
  const firstLine = text.split("\n")[0];
  const data = JSON.parse(firstLine);

  // The CID is in the "Hash" field
  return data.Hash;
}

export async function directStorageRequest(files: FileList, seedPhrase: string) {
  // 1. Upload each file to IPFS and get the CID
  const inputs = await Promise.all(
    Array.from(files).map(async file => {
      const cid = await uploadToIpfs(file); // <-- Upload and get CID
      return {
        file_hash: Array.from(new TextEncoder().encode(cid)), // Convert CID to Vec<u8>
        file_name: Array.from(new TextEncoder().encode(file.name)),
      };
    })
  );

  // 2. Call the Tauri command
  return invoke<string>("storage_request_tauri", {
    filesInput: inputs,
    minerIds: null,
    seedPhrase,
  });
}

export default function DirectStorageRequestDemo({ seedPhrase }: { seedPhrase: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleUpload = async () => {
    setResult(null);
    setError(null);
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) {
      setError("Please select at least one file.");
      return;
    }
    setLoading(true);
    try {
      const res = await directStorageRequest(files, seedPhrase);
      setResult(res as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: "2rem auto", padding: 24, border: "1px solid #eee", borderRadius: 8 }}>
      <h2>Direct Storage Request Demo</h2>
      <input type="file" multiple ref={fileInputRef} disabled={loading} />
      <br />
      <button onClick={handleUpload} disabled={loading} style={{ marginTop: 12 }}>
        {loading ? "Uploading..." : "Upload"}
      </button>
      {result && <div style={{ color: "green", marginTop: 12 }}>{result}</div>}
      {error && <div style={{ color: "red", marginTop: 12 }}>{error}</div>}
    </div>
  );
}