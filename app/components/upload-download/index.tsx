"use client";

import React, { useState } from "react";
// import { importAppData, type ImportDataParams } from "@/lib/helpers/restoreWallet";

export default function ImportAppDataDemo() {
  const [publicPath, setPublicPath] = useState<string>("");
  const [privatePath, setPrivatePath] = useState<string>("");
  const [keysCsv, setKeysCsv] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // const params: ImportDataParams = useMemo(
  //   () => ({
  //     public_sync_path: publicPath.trim() ? publicPath.trim() : null,
  //     private_sync_path: privatePath.trim() ? privatePath.trim() : null,
  //     encryption_keys: keysCsv
  //       .split(",")
  //       .map((s) => s.trim())
  //       .filter((s) => s.length > 0),
  //   }),
  //   [publicPath, privatePath, keysCsv]
  // );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // const res = await importAppData(params);
      setResult(null);
    } catch (err) {
      console.error("import_app_data failed", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: 12 }}>
        Import App Data (Demo)
      </h2>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Public sync path (optional)</span>
          <input
            type="text"
            value={publicPath}
            onChange={(e) => setPublicPath(e.target.value)}
            placeholder="/path/to/public"
            style={{ padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Private sync path (optional)</span>
          <input
            type="text"
            value={privatePath}
            onChange={(e) => setPrivatePath(e.target.value)}
            placeholder="/path/to/private"
            style={{ padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Encryption keys (comma separated, base64)</span>
          <input
            type="text"
            value={keysCsv}
            onChange={(e) => setKeysCsv(e.target.value)}
            placeholder="base64Key1, base64Key2"
            style={{ padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: 6,
            border: "1px solid #444",
            background: loading ? "#888" : "#222",
            color: "#fff",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Importing..." : "Call import_app_data"}
        </button>
      </form>

      {result && (
        <div style={{ marginTop: 12, color: "#0a7" }}>
          <strong>Result: </strong>
          <pre style={{ whiteSpace: "pre-wrap" }}>{result}</pre>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, color: "#c00" }}>
          <strong>Error: </strong>
          <pre style={{ whiteSpace: "pre-wrap" }}>{error}</pre>
        </div>
      )}
    </div>
  );
}
