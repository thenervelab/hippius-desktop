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
    logoutTimeInMinutes INTEGER DEFAULT 1440
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
    if (!(await exists(DB_FILENAME, { baseDir: BaseDirectory.AppLocalData }))) {
      return null;
    }
    return await readFile(DB_FILENAME, { baseDir: BaseDirectory.AppLocalData });
  } catch (err) {
    console.error("Error reading database file:", err);
    return null;
  }
}

export async function saveBytes(bytes: Uint8Array) {
  try {
    await ensureAppDirectory();
    await writeFile(DB_FILENAME, bytes, {
      baseDir: BaseDirectory.AppLocalData,
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

export async function initHippiusDesktopDB(): Promise<initSqlJsType.Database> {
  await ensureAppDirectory();
  let SQL: any;
  try {
    SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  } catch {
    console.error("Failed to initialize SQL.js");
  }

  let raw: any;
  try {
    raw = await getBytes();
  } catch {
    console.error("Failed to get database bytes");
  }

  let db: initSqlJsType.Database | undefined;
  try {
    db = raw ? new SQL.Database(raw) : new SQL.Database();
    if (db) {
      await createSchema(db); // ensure both wallet + session tables exist
    }
  } catch {
    console.error("Failed to create schema");
  }

  if (!db) {
    console.error("Failed to initialize database");
    throw new Error("Database initialization failed");
  }

  // sanity check
  try {
    db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallet'");
  } catch (err) {
    console.error("Failed to verify wallet table:", err);
    throw new Error(
      "Database initialization failed: could not verify wallet table"
    );
  }

  return db;
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
      await createSchema(db); // runs both CREATE IF NOT EXISTS
      await saveBytes(db.export()); // persist schema change
    }
    return true;
  } catch (err) {
    console.error("Failed to ensure schema:", err);
    return false;
  }
}

/* ─ Wallet helpers ───────────────────────────────────────────── */

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

    if (!res.length || !res[0]?.values.length) {
      return null;
    }

    const [encryptedMnemonic, passcodeHash] = res[0].values[0] as string[];
    return { encryptedMnemonic, passcodeHash };
  } catch (err) {
    console.error("Error fetching wallet record:", err);
    return null;
  }
}

export async function hasWalletRecord(): Promise<boolean> {
  const raw = await getBytes();
  if (!raw) return false;
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database(raw);
  const rows = db.exec("SELECT 1 FROM wallet LIMIT 1");
  return rows.length > 0 && rows[0].values.length > 0;
}

export async function clearHippiusDesktopDB() {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database();
  db.run(TABLE_SCHEMA);
  await saveBytes(db.export());
}
