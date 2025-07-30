import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import { initWalletDb, saveBytes } from "./walletDb";

/* ── schemas ─────────────────────────────── */

const ADDRESS_BOOK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS address_book (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    date_added INTEGER DEFAULT (strftime('%s','now')*1000)
  );
`;

/* ── helpers ─────────────────────────────── */

async function getDb(): Promise<initSqlJsType.Database> {
  const db = await initWalletDb();
  db.run(ADDRESS_BOOK_SCHEMA);
  return db;
}

/* address book CRUD */

export async function addContact(
  name: string,
  walletAddress: string
): Promise<boolean> {
  try {
    const db = await getDb();
    db.run(`INSERT INTO address_book (name, wallet_address) VALUES (?, ?)`, [
      name,
      walletAddress
    ]);
    await saveBytes(db.export());
    return true;
  } catch (error) {
    console.error("Failed to add contact:", error);
    return false;
  }
}

export async function getContacts(): Promise<
  Array<{ id: number; name: string; walletAddress: string; dateAdded: number }>
> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT id, name, wallet_address, date_added 
       FROM address_book 
       ORDER BY name ASC`
    );

    if (!res.length) return [];

    return res[0].values.map((row) => ({
      id: row[0] as number,
      name: row[1] as string,
      walletAddress: row[2] as string,
      dateAdded: row[3] as number
    }));
  } catch (error) {
    console.error("Failed to get contacts:", error);
    return [];
  }
}

export async function getContactById(
  id: number
): Promise<{ name: string; walletAddress: string; dateAdded: number } | null> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT name, wallet_address, date_added 
       FROM address_book 
       WHERE id = ?`,
      [id]
    );

    if (!res.length || res[0].values.length === 0) return null;

    const row = res[0].values[0];
    return {
      name: row[0] as string,
      walletAddress: row[1] as string,
      dateAdded: row[2] as number
    };
  } catch (error) {
    console.error("Failed to get contact by id:", error);
    return null;
  }
}

export async function getContactByAddress(
  walletAddress: string
): Promise<{ id: number; name: string; dateAdded: number } | null> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT id, name, date_added 
       FROM address_book 
       WHERE wallet_address = ?`,
      [walletAddress]
    );

    if (!res.length || res[0].values.length === 0) return null;

    const row = res[0].values[0];
    return {
      id: row[0] as number,
      name: row[1] as string,
      dateAdded: row[2] as number
    };
  } catch (error) {
    console.error("Failed to get contact by address:", error);
    return null;
  }
}

export async function updateContact(
  id: number,
  name: string,
  walletAddress: string
): Promise<boolean> {
  try {
    const db = await getDb();
    db.run(
      `UPDATE address_book 
       SET name = ?, wallet_address = ? 
       WHERE id = ?`,
      [name, walletAddress, id]
    );
    await saveBytes(db.export());
    return true;
  } catch (error) {
    console.error("Failed to update contact:", error);
    return false;
  }
}

export async function deleteContact(id: number): Promise<boolean> {
  try {
    const db = await getDb();
    db.run(`DELETE FROM address_book WHERE id = ?`, [id]);
    await saveBytes(db.export());
    return true;
  } catch (error) {
    console.error("Failed to delete contact:", error);
    return false;
  }
}

export async function contactExists(walletAddress: string): Promise<boolean> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT COUNT(*) FROM address_book WHERE wallet_address = ?`,
      [walletAddress]
    );
    return (res[0]?.values[0][0] as number) > 0;
  } catch (error) {
    console.error("Failed to check if contact exists:", error);
    return false;
  }
}
