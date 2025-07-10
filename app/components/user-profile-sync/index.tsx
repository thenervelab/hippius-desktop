// components/UserSyncedFiles.tsx
import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type UserProfileFile = {
  owner: string;
  cid: string;
  file_hash: string;
  file_name: string;
  file_size_in_bytes: number;
  is_assigned: boolean;
  last_charged_at: number;
  main_req_hash: string;
  selected_validator: string;
  total_replicas: number;
  block_number: number;
  profile_cid: string;
};

export default function UserSyncedFiles() {
  const [owner, setOwner] = useState("");
  const [files, setFiles] = useState<UserProfileFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchFiles = async () => {
    setLoading(true);
    setError(null);
    setFiles(null);
    try {
      // Make sure the command name matches your Rust #[tauri::command]
      const result = await invoke<UserProfileFile[]>("get_user_synced_files", { owner });
      setFiles(result);
    } catch (err: any) {
      setError(err?.toString() ?? "Unknown error");
    }
    setLoading(false);
  };

  return (
    <div style={{ padding: 24 }}>
      <h2>Get User Synced Files</h2>
      <input
        type="text"
        placeholder="Owner (account id)"
        value={owner}
        onChange={e => setOwner(e.target.value)}
        style={{ marginRight: 8 }}
      />
      <button onClick={fetchFiles} disabled={loading || !owner}>
        {loading ? "Loading..." : "Fetch"}
      </button>
      {error && <div style={{ color: "red", marginTop: 16 }}>{error}</div>}
      {files && (
        <div style={{ marginTop: 16 }}>
          <h3>Files:</h3>
          {files.length === 0 ? (
            <div>No files found.</div>
          ) : (
            <ul>
              {files.map((file, idx) => (
                <li key={idx}>
                  <b>{file.file_name}</b> ({file.file_size_in_bytes} bytes) - CID: {file.cid}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
