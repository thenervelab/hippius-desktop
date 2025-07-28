import initSqlJs from "sql.js/dist/sql-wasm.js";
import type initSqlJsType from "sql.js/dist/sql-wasm.js";

export const DB_KEY = "onboarding-db";
const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS onboarding (
    id INTEGER PRIMARY KEY,
    isOnboardingDone BOOLEAN DEFAULT 0
  );
`;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Uint8Array → base64 string */
function encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
}

/** base64 string → Uint8Array */
function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }
  return bytes;
}

async function getBytes(): Promise<Uint8Array | null> {
  const b64 = localStorage.getItem(DB_KEY);
  return b64 ? decode(b64) : null;
}

async function saveBytes(bytes: Uint8Array): Promise<boolean> {
  try {
    localStorage.setItem(DB_KEY, encode(bytes));
    return true;
  } catch (err) {
    console.error("saveBytes error:", err);
    return false;
  }
}

function createSchema(db: initSqlJsType.Database) {
  db.run(TABLE_SCHEMA);
}

// ─── Core API ────────────────────────────────────────────────────────────────

export async function initOnboardingDb(): Promise<initSqlJsType.Database> {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const raw = await getBytes();
  const db = raw ? new SQL.Database(raw) : new SQL.Database();
  createSchema(db);
  return db;
}

export async function ensureOnboardingTable(): Promise<boolean> {
  try {
    const db = await initOnboardingDb();
    const res = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding'"
    );
    if (!res.length || !res[0].values.length) {
      createSchema(db);
      await saveBytes(db.export());
    }
    return true;
  } catch (err) {
    console.error("ensureOnboardingTable error:", err);
    return false;
  }
}

export async function isOnboardingDone(): Promise<boolean> {
  try {
    await ensureOnboardingTable();
    const db = await initOnboardingDb();
    const res = db.exec(
      "SELECT isOnboardingDone FROM onboarding ORDER BY id DESC LIMIT 1"
    );
    if (!res.length || !res[0].values.length) return false;
    return Boolean(res[0].values[0][0]);
  } catch (err) {
    console.error("isOnboardingDone error:", err);
    return false;
  }
}

export async function setOnboardingDone(
  done: boolean = true
): Promise<boolean> {
  try {
    await ensureOnboardingTable();
    const db = await initOnboardingDb();
    const last = db.exec("SELECT id FROM onboarding ORDER BY id DESC LIMIT 1");
    const val = done ? 1 : 0;
    if (!last.length || !last[0].values.length) {
      db.run("INSERT INTO onboarding (isOnboardingDone) VALUES (?)", [val]);
    } else {
      const id = last[0].values[0][0];
      db.run("UPDATE onboarding SET isOnboardingDone = ? WHERE id = ?", [
        val,
        id
      ]);
    }
    await saveBytes(db.export());
    return true;
  } catch (err) {
    console.error("setOnboardingDone error:", err);
    return false;
  }
}

export async function clearOnboardingDb(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database();
  createSchema(db);
  await saveBytes(db.export());
}
