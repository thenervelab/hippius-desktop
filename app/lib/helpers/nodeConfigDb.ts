import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import { initWalletDb, saveBytes } from "./walletDb";

/* ── schemas ─────────────────────────────── */

const NODE_CONFIG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS node_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    wss_endpoint TEXT NOT NULL,
    date_updated INTEGER DEFAULT (strftime('%s','now')*1000)
  );
`;

const DEFAULT_WSS_ENDPOINT = "wss://rpc.hippius.network";

/* ── helpers ─────────────────────────────── */

async function getDb(): Promise<initSqlJsType.Database> {
  const db = await initWalletDb();
  db.run(NODE_CONFIG_SCHEMA);
  return db;
}

/* node config functions */

export async function getWssEndpoint(): Promise<string> {
  try {
    const db = await getDb();

    // Check if we have a saved endpoint
    const res = db.exec(`SELECT wss_endpoint FROM node_config WHERE id = 1`);

    if (res.length && res[0].values.length) {
      return res[0].values[0][0] as string;
    }

    // If no endpoint is saved, insert the default and return it
    db.run(
      `INSERT OR IGNORE INTO node_config (id, wss_endpoint) VALUES (1, ?)`,
      [DEFAULT_WSS_ENDPOINT]
    );
    await saveBytes(db.export());

    return DEFAULT_WSS_ENDPOINT;
  } catch (error) {
    console.error("Failed to get WSS endpoint:", error);
    return DEFAULT_WSS_ENDPOINT;
  }
}

export async function updateWssEndpoint(endpoint: string): Promise<boolean> {
  try {
    const db = await getDb();

    // Update if exists, insert if not
    db.run(
      `INSERT INTO node_config (id, wss_endpoint, date_updated) 
       VALUES (1, ?, (strftime('%s','now')*1000)) 
       ON CONFLICT(id) DO UPDATE SET 
       wss_endpoint = ?, 
       date_updated = (strftime('%s','now')*1000)`,
      [endpoint, endpoint]
    );

    await saveBytes(db.export());
    return true;
  } catch (error) {
    console.error("Failed to update WSS endpoint:", error);
    return false;
  }
}

// Reset to default endpoint
export async function resetWssEndpoint(): Promise<boolean> {
  return updateWssEndpoint(DEFAULT_WSS_ENDPOINT);
}
