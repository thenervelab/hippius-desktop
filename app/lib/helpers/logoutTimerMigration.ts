import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import { saveBytes, WALLET_TABLE_SCHEMA } from "./hippiusDesktopDB";

function columnExists(
  db: initSqlJsType.Database,
  table: string,
  column: string
): boolean {
  const res = db.exec(`PRAGMA table_info(${table})`);
  if (!res.length) return false;
  const nameIdx = res[0].columns.findIndex((c) => c === "name");
  return res[0].values.some((row) => row[nameIdx] === column);
}

function tableExists(db: initSqlJsType.Database, table: string): boolean {
  const res = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`
  );
  return !!(res.length && res[0].values.length);
}

export async function migrateSchema(
  db: initSqlJsType.Database
): Promise<boolean> {
  let changed = false;

  // 1) Create table if it doesn't exist (fresh installs)
  if (!tableExists(db, "wallet")) {
    db.run(WALLET_TABLE_SCHEMA);
    changed = true;
  }

  // 2) Add missing column for existing installs
  if (!columnExists(db, "wallet", "logoutTime")) {
    db.run("ALTER TABLE wallet ADD COLUMN logoutTime INTEGER DEFAULT 86400000");
    // Backfill existing rows that got NULL
    db.run("UPDATE wallet SET logoutTime = 86400000 WHERE logoutTime IS NULL");
    // Optional: track schema version
    db.run("PRAGMA user_version = 1");
    changed = true;
  }

  if (changed) {
    await saveBytes(db.export());
  }
  return changed;
}
