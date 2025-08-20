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
const FOREVER_MS = 1000 * 60 * 60 * 24 * 365 * 100;

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
    if (raw) {
      db = new SQL.Database(raw);
    } else {
      db = new SQL.Database();
    }
    // Always ensure the schema exists, regardless of whether we loaded an existing DB
    if (db) {
      await createSchema(db);
    }
  } catch {
    console.error("Failed to create schema");
  }
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

export async function saveSession(
  mnemonic: string,
  logoutTimeInMinutes?: number
): Promise<number> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    // Use explicit param if provided, else keep previous, else default 1440
    const prev = await getSession();
    const effectiveMinutes =
      logoutTimeInMinutes ?? prev?.logoutTimeInMinutes ?? 1440;

    const logoutTimeStamp =
      effectiveMinutes === -1
        ? Date.now() + FOREVER_MS
        : Date.now() + effectiveMinutes * 60_000;

    db.run("DELETE FROM session");
    db.run(
      "INSERT INTO session (mnemonic, logoutTimeStamp, logoutTimeInMinutes) VALUES (?, ?, ?)",
      [mnemonic, logoutTimeStamp, effectiveMinutes]
    );

    await saveBytes(db.export());
    return logoutTimeStamp;
  } catch (err) {
    console.error("Failed to save session:", err);
    throw err; // make caller handle failure
  }
}

export async function getSession(): Promise<{
  mnemonic: string;
  logoutTimeStamp: number;
  logoutTimeInMinutes: number;
} | null> {
  try {
    await ensureWalletTable();
    const db = await initHippiusDesktopDB();

    const res = db.exec(
      "SELECT mnemonic, logoutTimeStamp, logoutTimeInMinutes FROM session LIMIT 1"
    );

    if (!res.length || !res[0]?.values.length) {
      return null;
    }

    const [mnemonic, logoutTimeStamp, logoutTimeInMinutes] = res[0]
      .values[0] as [string, number, number];
    return {
      mnemonic,
      logoutTimeStamp,
      logoutTimeInMinutes: logoutTimeInMinutes || 1440, // Default to 24 hours if not set
    };
  } catch (err) {
    console.error("Error fetching session:", err);
    return null;
  }
}

export async function updateSessionTimeout(logoutTimeInMinutes: number) {
  try {
    const session = await getSession();
    if (!session) return false;

    // Update with the new timeout value
    await saveSession(session.mnemonic, logoutTimeInMinutes);
    return true;
  } catch (err) {
    console.error("Error updating session timeout:", err);
    return false;
  }
}

export async function clearSession() {
  try {
    const db = await initHippiusDesktopDB();
    db.run("DELETE FROM session");
    await saveBytes(db.export());
    return true;
  } catch (err) {
    console.error("Failed to clear session:", err);
    return false;
  }
}

export async function hasActiveSession(): Promise<boolean> {
  try {
    const session = await getSession();
    if (!session) return false;

    // Check if session is still valid (current time < logout timestamp)
    return Date.now() < session.logoutTimeStamp;
  } catch (err) {
    console.error("Error checking active session:", err);
    return false;
  }
}

export async function clearHippiusDesktopDB() {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database();
  db.run(TABLE_SCHEMA);
  await saveBytes(db.export());
}
