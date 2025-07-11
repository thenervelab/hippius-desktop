// app/components/DemoIpfsUpload.tsx
import React, { useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

/**
 * Calls the Tauri storage_request_tauri command directly.
 * @param files FileList from an <input type="file" />
 * @param seedPhrase The user's mnemonic/seed phrase as a string
 */
export async function directStorageRequest(files: FileList, seedPhrase: string) {
  // Prepare the input format expected by the backend
  const inputs = await Promise.all(
    Array.from(files).map(async file => ({
      file_hash: Array.from(new Uint8Array(await file.arrayBuffer())),
      file_name: Array.from(new TextEncoder().encode(file.name)),
    }))
  );

  // Call the Tauri command
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