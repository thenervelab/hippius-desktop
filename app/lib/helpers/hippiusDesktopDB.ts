/* eslint-disable @typescript-eslint/no-explicit-any */
import initSqlJs from "sql.js/dist/sql-wasm.js";
import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import {
  readFile,
  writeFile,
  exists,
  BaseDirectory,
  mkdir,
} from "@tauri-apps/plugin-fs";
import { getDefaultStore } from "jotai";
import {
  hippiusDbAtom,
  sqlJsModuleAtom,
  dbInitPromiseAtom,
  dbWriteQueueAtom,
} from "./dbAtoms";

export const DB_FILENAME = "hippius-desktop.db";
const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet (
    id INTEGER PRIMARY KEY,
    encryptedMnemonic TEXT,
    passcodeHash TEXT
  );

  CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY,
    mnemonic TEXT,
    logoutTimeStamp INTEGER,
    logoutTimeInMinutes INTEGER DEFAULT 1440,
    authToken TEXT,
    tokenExpiry INTEGER,
    userId INTEGER,
    username TEXT
  );
`;

export async function ensureAppDirectory() {
  try {
    await mkdir("", { baseDir: BaseDirectory.AppLocalData, recursive: true });
    return true;
  } catch (err) {
    console.error("Failed to create app directory:", err);
    return false;
  }
}

async function getBytes(): Promise<Uint8Array | null> {
  try {
    const fileExists = await exists(DB_FILENAME, {
      baseDir: BaseDirectory.AppLocalData,
    });
    if (!fileExists) return null;
    return await readFile(DB_FILENAME, { baseDir: BaseDirectory.AppLocalData });
  } catch (err) {
    console.error("Error reading database file:", err);
    return null;
  }
}

/** Serialize all writes to avoid clobbering. */
async function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const store = getDefaultStore();
  const prev = store.get(dbWriteQueueAtom);
  const next = prev
    .catch(() => void 0) // keep queue alive on error
    .then(fn);
  // store a promise that resolves when this write completes
  store.set(
    dbWriteQueueAtom,
    next.then(
      () => void 0,
      () => void 0
    )
  );
  return next;
}

export async function saveBytes(bytes: Uint8Array) {
  try {
    await ensureAppDirectory();
    await enqueueWrite(async () => {
      await writeFile(DB_FILENAME, bytes, {
        baseDir: BaseDirectory.AppLocalData,
      });
    });
    return true;
  } catch (err) {
    console.error("Failed to save database:", err);
    return false;
  }
}

async function createSchema(db: initSqlJsType.Database) {
  try {
    db.run(TABLE_SCHEMA);
    return true;
  } catch (err) {
    console.error("Failed to create schema:", err);
    return false;
  }
}

// Safe migration for existing DBs: ensure new session columns exist
export async function ensureSessionAuthColumns(): Promise<boolean> {
  try {
    const db = await initHippiusDesktopDB();
    const info = db.exec("PRAGMA table_info('session')");
    const cols =
      info.length && info[0]?.values?.length
        ? new Set(info[0].values.map((r) => String(r[1])))
        : new Set<string>();

    const missing: string[] = [];
    if (!cols.has("authToken")) missing.push("authToken TEXT");
    if (!cols.has("tokenExpiry")) missing.push("tokenExpiry INTEGER");
    if (!cols.has("userId")) missing.push("userId INTEGER");
    if (!cols.has("username")) missing.push("username TEXT");

    if (missing.length) {
      for (const def of missing) {
        db.run(`ALTER TABLE session ADD COLUMN ${def}`);
      }
      await saveBytes(db.export());
    }
    return true;
  } catch (err) {
    console.error("Failed to ensure session auth columns:", err);
    return false;
  }
}

/** Single entry point that returns the shared DB instance. */
export async function initHippiusDesktopDB(): Promise<initSqlJsType.Database> {
  const store = getDefaultStore();
  // Already created
  const existing = store.get(hippiusDbAtom);
  if (existing) return existing;

  // Dedupe concurrent init
  let inFlight = store.get(dbInitPromiseAtom);
  if (!inFlight) {
    inFlight = (async () => {
      // Reuse loaded SQL.js module
      let SQL: any = store.get(sqlJsModuleAtom);
      if (!SQL) {
        SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
        store.set(sqlJsModuleAtom, SQL);
      }

      const raw = await getBytes();
      const db: initSqlJsType.Database = raw
        ? new SQL.Database(raw)
        : new SQL.Database();

      await createSchema(db);

      // If this is the first creation (no file), persist schema once
      if (!raw) {
        await saveBytes(db.export());
      }

      // Sanity: wallet table must exist
      db.exec(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallet'"
      );

      // Ensure auth columns on session for both fresh and existing DBs
      try {
        const info = db.exec("PRAGMA table_info('session')");
        const cols =
          info.length && info[0]?.values?.length
            ? new Set(info[0].values.map((r) => String(r[1])))
            : new Set<string>();
        const toAdd: string[] = [];
        if (!cols.has("authToken")) toAdd.push("authToken TEXT");
        if (!cols.has("tokenExpiry")) toAdd.push("tokenExpiry INTEGER");
        if (!cols.has("userId")) toAdd.push("userId INTEGER");
        if (!cols.has("username")) toAdd.push("username TEXT");
        if (toAdd.length) {
          for (const def of toAdd) db.run(`ALTER TABLE session ADD COLUMN ${def}`);
          await saveBytes(db.export());
        }
      } catch (e) {
        console.error("Failed to ensure auth columns:", e);
      }

      store.set(hippiusDbAtom, db);
      return db;
    })();

    store.set(dbInitPromiseAtom, inFlight);
  }

  try {
    const db = await inFlight;
    return db;
  } finally {
    // clear the in-flight marker
    store.set(dbInitPromiseAtom, null);
  }
}

export async function ensureWalletTable(): Promise<boolean> {
  try {
    const db = await initHippiusDesktopDB();

    const hasWallet = db.exec(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallet' LIMIT 1"
    );
    const hasSession = db.exec(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session' LIMIT 1"
    );

    const missingWallet = !hasWallet.length || !hasWallet[0]?.values.length;
    const missingSession = !hasSession.length || !hasSession[0]?.values.length;

    if (missingWallet || missingSession) {
      await createSchema(db);
      await saveBytes(db.export());
    }

    // Ensure auth-related columns exist on session for existing DBs
    await ensureSessionAuthColumns();

    return true;
  } catch (err) {
    console.error("Failed to ensure schema:", err);
    return false;
  }
}

/* ─ Wallet helpers ─ */

export async function saveWallet(
  encryptedMnemonic: string,
  passcodeHash: string
) {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();
    db.run(
      "INSERT INTO wallet (encryptedMnemonic, passcodeHash) VALUES (?, ?)",
      [encryptedMnemonic, passcodeHash]
    );
    await saveBytes(db.export());
    return true;
  } catch (err) {
    console.error("Failed to save wallet:", err);
    throw err;
  }
}

export async function updateWallet(
  encryptedMnemonic: string,
  passcodeHash: string
) {
  const db = await initHippiusDesktopDB();
  const res = db.exec("SELECT id FROM wallet ORDER BY id DESC LIMIT 1");
  if (!res[0]?.values.length) {
    throw new Error("No wallet record found to update");
  }
  const id = res[0].values[0][0];
  db.run(
    "UPDATE wallet SET encryptedMnemonic = ?, passcodeHash = ? WHERE id = ?",
    [encryptedMnemonic, passcodeHash, id]
  );
  await saveBytes(db.export());
}

export async function getWalletRecord(): Promise<{
  encryptedMnemonic: string;
  passcodeHash: string;
} | null> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    const res = db.exec(
      "SELECT encryptedMnemonic, passcodeHash FROM wallet ORDER BY id DESC LIMIT 1"
    );

    if (!res.length || !res[0]?.values.length) return null;

    const [encryptedMnemonic, passcodeHash] = res[0].values[0] as string[];
    return { encryptedMnemonic, passcodeHash };
  } catch (err) {
    console.error("Error fetching wallet record:", err);
    return null;
  }
}

/** Use the shared DB (no extra instance). */
export async function hasWalletRecord(): Promise<boolean> {
  const db = await initHippiusDesktopDB();
  const rows = db.exec("SELECT 1 FROM wallet LIMIT 1");
  return rows.length > 0 && rows[0].values.length > 0;
}

/** Reset DB file and update the shared instance reference. */
export async function clearHippiusDesktopDB() {
  const store = getDefaultStore();
  let SQL: any = store.get(sqlJsModuleAtom);
  if (!SQL) {
    SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
    store.set(sqlJsModuleAtom, SQL);
  }
  const db = new SQL.Database();
  db.run(TABLE_SCHEMA);
  await saveBytes(db.export());
  store.set(hippiusDbAtom, db);
}
