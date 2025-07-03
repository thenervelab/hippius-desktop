import initSqlJs from "sql.js/dist/sql-wasm.js";
import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import {
  readFile,
  writeFile,
  exists,
  BaseDirectory,
  mkdir,
} from "@tauri-apps/plugin-fs";

export const DB_FILENAME = "wallet.db";
const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet (
    id INTEGER PRIMARY KEY,
    encryptedMnemonic TEXT,
    passcodeHash TEXT
  );
`;

async function ensureAppDirectory() {
  try {
    // create the AppLocalData folder structure if missing
    await mkdir("", {
      baseDir: BaseDirectory.AppLocalData,
      recursive: true, // ← allows nested dirs :contentReference[oaicite:1]{index=1}
    });
  } catch (err) {
    console.error("Failed to create app directory:", err);
  }
}

/** Load raw bytes if the file exists */
async function getBytes(): Promise<Uint8Array | null> {
  if (!(await exists(DB_FILENAME, { baseDir: BaseDirectory.AppLocalData }))) {
    return null;
  }
  return await readFile(DB_FILENAME, { baseDir: BaseDirectory.AppLocalData });
}

/** Persist raw bytes to disk */
export async function saveBytes(bytes: Uint8Array) {
  await writeFile(DB_FILENAME, bytes, { baseDir: BaseDirectory.AppLocalData });
}

/** Initialize or load the DB */
export async function initWalletDb(): Promise<initSqlJsType.Database> {
  await ensureAppDirectory();
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const raw = await getBytes();

  let db: initSqlJsType.Database;
  if (raw) {
    // load existing file
    db = new SQL.Database(raw);
  } else {
    // create new DB and schema
    db = new SQL.Database();
    db.run(TABLE_SCHEMA);
    await saveBytes(db.export());
  }
  return db;
}

/** Insert a new wallet record */
export async function saveWallet(
  encryptedMnemonic: string,
  passcodeHash: string
) {
  const db = await initWalletDb();
  db.run("INSERT INTO wallet (encryptedMnemonic, passcodeHash) VALUES (?, ?)", [
    encryptedMnemonic,
    passcodeHash,
  ]);
  await saveBytes(db.export());
}

/** Update the existing wallet record */
export async function updateWallet(
  encryptedMnemonic: string,
  passcodeHash: string
) {
  const db = await initWalletDb();
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

/** Fetch the latest wallet record */
export async function getWalletRecord(): Promise<{
  encryptedMnemonic: string;
  passcodeHash: string;
} | null> {
  const db = await initWalletDb();
  const res = db.exec(
    "SELECT encryptedMnemonic, passcodeHash FROM wallet ORDER BY id DESC LIMIT 1"
  );
  if (!res[0]?.values.length) return null;
  const [encryptedMnemonic, passcodeHash] = res[0].values[0] as string[];
  return { encryptedMnemonic, passcodeHash };
}

/** Check if any record exists */
export async function hasWalletRecord(): Promise<boolean> {
  const raw = await getBytes();
  if (!raw) return false;
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database(raw);
  const rows = db.exec("SELECT 1 FROM wallet LIMIT 1");
  return rows.length > 0 && rows[0].values.length > 0;
}

/** Wipe the DB (recreate empty schema) */
export async function clearWalletDb() {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database();
  db.run(TABLE_SCHEMA);
  await saveBytes(db.export());
}
