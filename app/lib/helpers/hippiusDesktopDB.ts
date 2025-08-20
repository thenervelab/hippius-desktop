import initSqlJs from "sql.js/dist/sql-wasm.js";
import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import {
  readFile,
  writeFile,
  exists,
  BaseDirectory,
  mkdir,
} from "@tauri-apps/plugin-fs";
import { migrateSchema } from "./logoutTimerMigration";

export const DB_FILENAME = "hippius-desktop.db";
export const WALLET_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet (
    id INTEGER PRIMARY KEY,
    encryptedMnemonic TEXT,
    passcodeHash TEXT,
    logoutTime INTEGER DEFAULT 86400000
  );
`;

// Default logout time values in milliseconds
export const LOGOUT_TIMES = {
  MINUTES_15: 15 * 60 * 1000,
  HOUR_1: 60 * 60 * 1000,
  HOURS_8: 8 * 60 * 60 * 1000,
  HOURS_24: 24 * 60 * 60 * 1000,
  DAYS_3: 3 * 24 * 60 * 60 * 1000,
  FOREVER: -1, // Special value for no timeout
};

export async function ensureAppDirectory() {
  try {
    await mkdir("", {
      baseDir: BaseDirectory.AppLocalData,
      recursive: true,
    });
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
    db.run(WALLET_TABLE_SCHEMA);
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
    if (raw) {
      db = await new SQL.Database(raw);
    } else {
      db = await new SQL.Database();
    }
    // Always ensure the schema exists, regardless of whether we loaded an existing DB
    if (db) {
      await createSchema(db);
      await migrateSchema(db);
    }
  } catch {
    console.error("Failed to create schema");
  }
  console.log(SQL, db, raw, "sql,db,raw");
  if (!db) {
    console.error("Failed to initialize database");
    throw new Error("Database initialization failed");
  }
  // Verify the table exists
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
    const result = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='wallet'"
    );
    if (!result.length || !result[0].values.length) {
      await createSchema(db);
      await saveBytes(db.export());
    }
    return true;
  } catch (err) {
    console.error("Failed to ensure wallet table:", err);
    return false;
  }
}

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
  // Get the latest wallet record id
  const res = db.exec("SELECT id FROM wallet ORDER BY id DESC LIMIT 1");
  if (!res[0]?.values.length) {
    throw new Error("No wallet record found to update");
  }
  const id = res[0].values[0][0];

  // Update the record
  db.run(
    "UPDATE wallet SET encryptedMnemonic = ?, passcodeHash = ? WHERE id = ?",
    [encryptedMnemonic, passcodeHash, id]
  );
  await saveBytes(db.export());
}

export async function getWalletRecord(): Promise<{
  encryptedMnemonic: string;
  passcodeHash: string;
  logoutTime: number;
} | null> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    const res = db.exec(
      "SELECT encryptedMnemonic, passcodeHash, logoutTime FROM wallet ORDER BY id DESC LIMIT 1"
    );

    if (!res.length || !res[0]?.values.length) {
      return null;
    }

    const [encryptedMnemonic, passcodeHash, logoutTime] = res[0].values[0];
    return {
      encryptedMnemonic: encryptedMnemonic as string,
      passcodeHash: passcodeHash as string,
      logoutTime: (logoutTime as number) || LOGOUT_TIMES.HOURS_24,
    };
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

export async function getLogoutTime(): Promise<number> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    const res = db.exec(
      "SELECT logoutTime FROM wallet ORDER BY id DESC LIMIT 1"
    );

    if (!res.length || !res[0]?.values.length) {
      return LOGOUT_TIMES.HOURS_24; // Default to 24 hours if no record exists
    }

    return (res[0].values[0][0] as number) || LOGOUT_TIMES.HOURS_24;
  } catch (err) {
    console.error("Error fetching logout time:", err);
    return LOGOUT_TIMES.HOURS_24; // Default to 24 hours on error
  }
}

export async function updateLogoutTime(logoutTime: number): Promise<boolean> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    // Get the latest wallet record id
    const res = db.exec("SELECT id FROM wallet ORDER BY id DESC LIMIT 1");
    if (!res[0]?.values.length) {
      throw new Error("No wallet record found to update logout time");
    }
    const id = res[0].values[0][0];

    // Update the record with new logout time
    db.run("UPDATE wallet SET logoutTime = ? WHERE id = ?", [logoutTime, id]);
    await saveBytes(db.export());
    return true;
  } catch (err) {
    console.error("Failed to update logout time:", err);
    return false;
  }
}

export async function clearHippiusDesktopDB() {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database();
  db.run(WALLET_TABLE_SCHEMA);
  await saveBytes(db.export());
}
