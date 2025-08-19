"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type RecentItem = {
  name: string;
  path: string;
  scope: "public" | "private" | string;
  action: "uploaded" | "deleted" | "uploading" | "queued" | string;
  kind: "file" | "folder" | "unknown" | string;
};

type SyncActivityResponse = {
  recent: RecentItem[];
  uploading: RecentItem[];
  queued: RecentItem[];
};

export default function RecentSyncItemsDemo() {
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [uploading, setUploading] = useState<RecentItem[]>([]);
  const [queued, setQueued] = useState<RecentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState<number>(5);
  const [noLimit, setNoLimit] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const args = noLimit ? {} : { limit };
      const res = (await invoke("get_sync_activity", args)) as SyncActivityResponse;
      setRecent(Array.isArray(res?.recent) ? res.recent : []);
      setUploading(Array.isArray(res?.uploading) ? res.uploading : []);
      setQueued(Array.isArray(res?.queued) ? res.queued : []);
    } catch (e) {
      console.error("get_sync_activity failed", e);
      setError(e instanceof Error ? e.message : String(e));
      setRecent([]);
      setUploading([]);
      setQueued([]);
    } finally {
      setLoading(false);
    }
  }, [limit, noLimit]);

  useEffect(() => {
    if (autoRefresh) {
      fetchItems();
      timerRef.current = setInterval(fetchItems, 3000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, fetchItems]);

  const counts = useMemo(
    () => `Recent: ${recent.length} · Uploading: ${uploading.length} · Queued: ${queued.length}`,
    [recent.length, uploading.length, queued.length]
  );

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: 8 }}>Sync Activity</h3>
      <div style={{ color: "#666", marginBottom: 6 }}>{counts}</div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", opacity: noLimit ? 0.5 : 1 }}>
          <span>Limit</span>
          <input
            type="number"
            min={1}
            max={25}
            value={limit}
            disabled={noLimit}
            onChange={(e) => setLimit(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
            style={{ width: 72, padding: 6, border: "1px solid #ccc", borderRadius: 6 }}
          />
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={noLimit}
            onChange={(e) => setNoLimit(e.target.checked)}
          />
          <span>No limit (return all)</span>
        </label>
        <button
          onClick={fetchItems}
          disabled={loading}
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid #444",
            background: loading ? "#888" : "#222",
            color: "#fff",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          <span>Auto refresh (3s)</span>
        </label>
      </div>

      {error && (
        <div style={{ marginTop: 8, color: "#c00" }}>
          <strong>Error: </strong>
          <pre style={{ whiteSpace: "pre-wrap" }}>{error}</pre>
        </div>
      )}

      {/* Uploading */}
      <h4 style={{ margin: "12px 0 6px", fontWeight: 600 }}>Uploading</h4>
      {uploading.length === 0 ? (
        <div style={{ color: "#666" }}>No items currently uploading.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {uploading.map((it, idx) => (
            <li key={`up-${it.path}-${idx}`} style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, background: "#fff7e6" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{it.scope === "public" ? "🌐" : "🔒"}</span>
                <strong>{it.name}</strong>
                <span style={{ color: "#b35c00" }}>uploading</span>
                <span style={{ color: "#555" }}>({it.kind})</span>
              </div>
              <div style={{ color: "#555", fontSize: 12 }}>{it.path}</div>
            </li>
          ))}
        </ul>
      )}

      {/* Queued */}
      <h4 style={{ margin: "12px 0 6px", fontWeight: 600 }}>Queued</h4>
      {queued.length === 0 ? (
        <div style={{ color: "#666" }}>No items in queue.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {queued.map((it, idx) => (
            <li key={`q-${it.path}-${idx}`} style={{ border: "1px solid #ddd", borderRadius: 6, padding: 8, background: "#eef6ff" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{it.scope === "public" ? "🌐" : "🔒"}</span>
                <strong>{it.name}</strong>
                <span style={{ color: "#0a5" }}>queued</span>
                <span style={{ color: "#555" }}>({it.kind})</span>
              </div>
              <div style={{ color: "#555", fontSize: 12 }}>{it.path}</div>
            </li>
          ))}
        </ul>
      )}

      {/* Recent */}
      <h4 style={{ margin: "12px 0 6px", fontWeight: 600 }}>Recent</h4>
      {recent.length === 0 && !error ? (
        <div style={{ color: "#666" }}>No recent items.</div>
      ) : null}
      {recent.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {recent.map((it, idx) => (
            <li
              key={`r-${it.path}-${idx}`}
              style={{
                border: "1px solid #ddd",
                borderRadius: 6,
                padding: 8,
                display: "grid",
                gap: 2,
                background: "#fafafa",
              }}
            >
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span>{it.scope === "public" ? "🌐" : "🔒"}</span>
                <strong>{it.name}</strong>
                <span style={{ color: it.action === "deleted" ? "#b00" : "#0a7" }}>
                  {it.action}
                </span>
                <span style={{ color: "#555" }}>({it.kind})</span>
              </div>
              <div style={{ color: "#555", fontSize: 12 }}>{it.path}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
