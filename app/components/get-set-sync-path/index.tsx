import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Utility functions
export async function getPublicSyncPath(): Promise<string> {
  const result = await invoke<{ path: string }>("get_sync_path", { isPublic: true });
  return result.path;
}

export async function getPrivateSyncPath(): Promise<string> {
  const result = await invoke<{ path: string }>("get_sync_path", { isPublic: false });
  return result.path;
}

export async function setPublicSyncPath(path: string): Promise<string> {
  return await invoke<string>("set_sync_path", {
    params: { path, isPublic: true },
  });
}

export async function setPrivateSyncPath(path: string): Promise<string> {
  return await invoke<string>("set_sync_path", {
    params: { path, is_public: false },
  });
}

export default function SyncPathDemo() {
  const [publicPath, setPublicPath] = useState<string>("");
  const [privatePath, setPrivatePath] = useState<string>("");
  const [newPublicPath, setNewPublicPath] = useState<string>("");
  const [newPrivatePath, setNewPrivatePath] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  // Fetch public sync path
  const fetchPublicSyncPath = async () => {
    setStatus("Loading public path...");
    try {
      const path = await getPublicSyncPath();
      setPublicPath(path);
      setStatus("Fetched public path successfully!");
    } catch (err) {
      setStatus("Error fetching public path: " + (err as Error).message);
    }
  };

  // Fetch private sync path
  const fetchPrivateSyncPath = async () => {
    setStatus("Loading private path...");
    try {
      const path = await getPrivateSyncPath();
      setPrivatePath(path);
      setStatus("Fetched private path successfully!");
    } catch (err) {
      setStatus("Error fetching private path: " + (err as Error).message);
    }
  };

  // Set public sync path
  const updatePublicSyncPath = async () => {
    setStatus("Updating public path...");
    try {
      const result = await setPublicSyncPath(newPublicPath);
      setStatus(result);
      fetchPublicSyncPath();
    } catch (err) {
      setStatus("Error setting public path: " + (err as Error).message);
    }
  };

  // Set private sync path
  const updatePrivateSyncPath = async () => {
    setStatus("Updating private path...");
    try {
      const result = await setPrivateSyncPath(newPrivatePath);
      setStatus(result);
      fetchPrivateSyncPath();
    } catch (err) {
      console.error("Set private path error:", err);
      setStatus("Error setting private path: " + (err instanceof Error ? err.message : JSON.stringify(err)));
    }
  };

  return (
    <div style={{ maxWidth: 500, margin: "2rem auto", padding: 24, border: "1px solid #ccc", borderRadius: 8 }}>
      <h2>Sync Path Demo</h2>
      <div style={{ marginBottom: 24 }}>
        <button onClick={fetchPublicSyncPath} style={{ marginRight: 8 }}>Get Public Sync Path</button>
        <button onClick={fetchPrivateSyncPath}>Get Private Sync Path</button>
      </div>
      <div style={{ marginBottom: 16 }}>
        <strong>Public Path:</strong>
        <div style={{ background: "#f5f5f5", padding: 8, borderRadius: 4, margin: "8px 0" }}>
          {publicPath || <em>Not loaded</em>}
        </div>
        <input
          type="text"
          placeholder="Enter new public sync path"
          value={newPublicPath}
          onChange={e => setNewPublicPath(e.target.value)}
          style={{ width: "100%", padding: 8, borderRadius: 4, border: "1px solid #ccc", marginBottom: 8 }}
        />
        <button onClick={updatePublicSyncPath}>Set Public Sync Path</button>
      </div>
      <div style={{ marginBottom: 16 }}>
        <strong>Private Path:</strong>
        <div style={{ background: "#f5f5f5", padding: 8, borderRadius: 4, margin: "8px 0" }}>
          {privatePath || <em>Not loaded</em>}
        </div>
        <input
          type="text"
          placeholder="Enter new private sync path"
          value={newPrivatePath}
          onChange={e => setNewPrivatePath(e.target.value)}
          style={{ width: "100%", padding: 8, borderRadius: 4, border: "1px solid #ccc", marginBottom: 8 }}
        />
        <button onClick={updatePrivateSyncPath}>Set Private Sync Path</button>
      </div>
      <div style={{ marginTop: 16, color: "#555" }}>{status}</div>
    </div>
  );
}