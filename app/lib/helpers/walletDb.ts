import type initSqlJsType from "sql.js/dist/sql-wasm";

export const DB_KEY = "walletDB";
const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet (
    id INTEGER PRIMARY KEY,
    encryptedMnemonic TEXT,
    passcodeHash TEXT
  );
`;

export async function initWalletDb(): Promise<initSqlJsType.Database> {
  // 👇 ONLY use the WASM build here
  const initSqlJs = (await import("sql.js/dist/sql-wasm.js")).default;
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const dbData = localStorage.getItem(DB_KEY);
  let db: initSqlJsType.Database;
  if (dbData) {
    db = new SQL.Database(
      Uint8Array.from(atob(dbData), (c) => c.charCodeAt(0))
    );
  } else {
    db = new SQL.Database();
    db.run(TABLE_SCHEMA);
  }
  return db;
}

export async function saveWallet(
  encryptedMnemonic: string,
  passcodeHash: string
) {
  const db = await initWalletDb();
  db.run("INSERT INTO wallet (encryptedMnemonic, passcodeHash) VALUES (?, ?)", [
    encryptedMnemonic,
    passcodeHash,
  ]);
  const data = db.export();
  const b64 = btoa(String.fromCharCode(...data));
  localStorage.setItem(DB_KEY, b64);
}

export async function getWalletRecord(): Promise<{
  encryptedMnemonic: string;
  passcodeHash: string;
} | null> {
  const db = await initWalletDb();
  const res = db.exec(
    "SELECT encryptedMnemonic, passcodeHash FROM wallet ORDER BY id DESC LIMIT 1"
  );
  if (!res.length || !res[0].values.length) return null;
  const row = res[0].values[0];
  return {
    encryptedMnemonic: row[0] as string,
    passcodeHash: row[1] as string,
  };
}

export async function hasWalletRecord(): Promise<boolean> {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const dbData = localStorage.getItem("walletDB");
  if (!dbData) return false;

  const db = new SQL.Database(
    Uint8Array.from(atob(dbData), (c) => c.charCodeAt(0))
  );
  const res = db.exec("SELECT 1 FROM wallet LIMIT 1");
  return res.length > 0 && res[0].values.length > 0;
}

export function clearWalletDb() {
  localStorage.removeItem(DB_KEY);
}
