import initSqlJs from "sql.js/dist/sql-wasm.js";
import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import {
  readFile,
  writeFile,
  exists,
  BaseDirectory,
  mkdir
} from "@tauri-apps/plugin-fs";

export const DB_FILENAME = "onboarding.db";
const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS onboarding (
    id INTEGER PRIMARY KEY,
    isOnboardingDone BOOLEAN DEFAULT 0
  );
`;

export async function ensureAppDirectory() {
  try {
    await mkdir("", {
      baseDir: BaseDirectory.AppLocalData,
      recursive: true
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
      baseDir: BaseDirectory.AppLocalData
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

export async function initOnboardingDb(): Promise<initSqlJsType.Database> {
  await ensureAppDirectory();
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const raw = await getBytes();

  let db: initSqlJsType.Database;

  if (raw) {
    db = new SQL.Database(raw);
  } else {
    db = new SQL.Database();
  }

  // Always ensure the schema exists
  await createSchema(db);

  // Verify the table exists
  try {
    db.exec(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='onboarding'"
    );
  } catch (err) {
    console.error("Failed to verify onboarding table:", err);
    throw new Error(
      "Database initialization failed: could not verify onboarding table"
    );
  }

  return db;
}

export async function ensureOnboardingTable(): Promise<boolean> {
  try {
    const db = await initOnboardingDb();
    const result = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding'"
    );
    if (!result.length || !result[0].values.length) {
      await createSchema(db);
      await saveBytes(db.export());
    }
    return true;
  } catch (err) {
    console.error("Failed to ensure onboarding table:", err);
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

    if (!res.length || !res[0]?.values.length) {
      // If no record exists, onboarding is not done
      return false;
    }

    // Convert SQLite value (0/1) to boolean
    return Boolean(res[0].values[0][0]);
  } catch (err) {
    console.error("Error checking onboarding status:", err);
    return false;
  }
}

export async function setOnboardingDone(
  done: boolean = true
): Promise<boolean> {
  try {
    await ensureOnboardingTable();
    const db = await initOnboardingDb();

    const res = db.exec("SELECT id FROM onboarding ORDER BY id DESC LIMIT 1");

    // Convert boolean to SQLite integer (0/1)
    const doneValue = done ? 1 : 0;

    if (!res.length || !res[0]?.values.length) {
      // No record exists, create a new one
      db.run("INSERT INTO onboarding (isOnboardingDone) VALUES (?)", [
        doneValue
      ]);
    } else {
      // Update existing record
      const id = res[0].values[0][0];
      db.run("UPDATE onboarding SET isOnboardingDone = ? WHERE id = ?", [
        doneValue,
        id
      ]);
    }

    await saveBytes(db.export());
    return true;
  } catch (err) {
    console.error("Failed to update onboarding status:", err);
    return false;
  }
}

export async function clearOnboardingDb() {
  const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
  const db = new SQL.Database();
  db.run(TABLE_SCHEMA);
  await saveBytes(db.export());
}
