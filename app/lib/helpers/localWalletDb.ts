/**
 * Local Wallet Database Helpers
 * Manages multiple encrypted wallets stored locally in SQLite
 */
import type initSqlJsType from "sql.js/dist/sql-wasm.js";
import { initHippiusDesktopDB, saveBytes } from "./hippiusDesktopDB";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

/* ── Types ─────────────────────────────── */

export interface LocalWallet {
  id: number;
  name: string;
  address: string;
  encryptedMnemonic: string;
  passwordHash: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWalletParams {
  name: string;
  mnemonic: string;
  encryptedMnemonic: string;
  passwordHash: string;
}

/* ── Schema ─────────────────────────────── */

const LOCAL_WALLETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS local_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    encrypted_mnemonic TEXT NOT NULL,
    passcode_hash TEXT NOT NULL,
    is_active INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')*1000),
    updated_at INTEGER DEFAULT (strftime('%s','now')*1000)
  );
`;

/* ── Helpers ─────────────────────────────── */

async function getDb(): Promise<initSqlJsType.Database> {
  const db = await initHippiusDesktopDB();
  db.run(LOCAL_WALLETS_SCHEMA);
  return db;
}

/**
 * Derive the Polkadot address from a mnemonic
 */
export async function deriveAddressFromMnemonic(mnemonic: string): Promise<string> {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromMnemonic(mnemonic);
  return pair.address;
}

/* ── CRUD Operations ─────────────────────────────── */

/**
 * Create a new local wallet
 */
export async function createLocalWallet(params: CreateWalletParams): Promise<LocalWallet | null> {
  try {
    const db = await getDb();

    // Derive address from mnemonic
    const address = await deriveAddressFromMnemonic(params.mnemonic);

    // Check if wallet with this address already exists
    const existing = db.exec(
      `SELECT id FROM local_wallets WHERE address = ?`,
      [address]
    );

    if (existing.length > 0 && existing[0]?.values.length > 0) {
      throw new Error("A wallet with this address already exists");
    }

    // If this is the first wallet, make it active
    const walletCount = db.exec(`SELECT COUNT(*) FROM local_wallets`);
    const isFirst = walletCount.length === 0 ||
      (walletCount[0]?.values[0]?.[0] as number) === 0;

    const now = Date.now();
    db.run(
      `INSERT INTO local_wallets (name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [params.name, address, params.encryptedMnemonic, params.passwordHash, isFirst ? 1 : 0, now, now]
    );

    await saveBytes(db.export());

    // Fetch and return the created wallet
    const res = db.exec(
      `SELECT id, name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at 
       FROM local_wallets WHERE address = ?`,
      [address]
    );

    if (!res.length || !res[0]?.values.length) return null;

    const row = res[0].values[0];
    return {
      id: row[0] as number,
      name: row[1] as string,
      address: row[2] as string,
      encryptedMnemonic: row[3] as string,
      passwordHash: row[4] as string,
      isActive: (row[5] as number) === 1,
      createdAt: row[6] as number,
      updatedAt: row[7] as number,
    };
  } catch (error) {
    console.error("Failed to create local wallet:", error);
    throw error;
  }
}

/**
 * Get all local wallets
 */
export async function getAllLocalWallets(): Promise<LocalWallet[]> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT id, name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at 
       FROM local_wallets 
       ORDER BY created_at ASC`
    );

    if (!res.length) return [];

    return res[0].values.map((row) => ({
      id: row[0] as number,
      name: row[1] as string,
      address: row[2] as string,
      encryptedMnemonic: row[3] as string,
      passwordHash: row[4] as string,
      isActive: (row[5] as number) === 1,
      createdAt: row[6] as number,
      updatedAt: row[7] as number,
    }));
  } catch (error) {
    console.error("Failed to get local wallets:", error);
    return [];
  }
}

/**
 * Get the active local wallet
 */
export async function getActiveLocalWallet(): Promise<LocalWallet | null> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT id, name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at 
       FROM local_wallets 
       WHERE is_active = 1
       LIMIT 1`
    );

    if (!res.length || !res[0]?.values.length) return null;

    const row = res[0].values[0];
    return {
      id: row[0] as number,
      name: row[1] as string,
      address: row[2] as string,
      encryptedMnemonic: row[3] as string,
      passwordHash: row[4] as string,
      isActive: (row[5] as number) === 1,
      createdAt: row[6] as number,
      updatedAt: row[7] as number,
    };
  } catch (error) {
    console.error("Failed to get active local wallet:", error);
    return null;
  }
}

/**
 * Get a local wallet by ID
 */
export async function getLocalWalletById(id: number): Promise<LocalWallet | null> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT id, name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at 
       FROM local_wallets 
       WHERE id = ?`,
      [id]
    );

    if (!res.length || !res[0]?.values.length) return null;

    const row = res[0].values[0];
    return {
      id: row[0] as number,
      name: row[1] as string,
      address: row[2] as string,
      encryptedMnemonic: row[3] as string,
      passwordHash: row[4] as string,
      isActive: (row[5] as number) === 1,
      createdAt: row[6] as number,
      updatedAt: row[7] as number,
    };
  } catch (error) {
    console.error("Failed to get local wallet by ID:", error);
    return null;
  }
}

/**
 * Get a local wallet by address
 */
export async function getLocalWalletByAddress(address: string): Promise<LocalWallet | null> {
  try {
    const db = await getDb();
    const res = db.exec(
      `SELECT id, name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at 
       FROM local_wallets 
       WHERE address = ?`,
      [address]
    );

    if (!res.length || !res[0]?.values.length) return null;

    const row = res[0].values[0];
    return {
      id: row[0] as number,
      name: row[1] as string,
      address: row[2] as string,
      encryptedMnemonic: row[3] as string,
      passwordHash: row[4] as string,
      isActive: (row[5] as number) === 1,
      createdAt: row[6] as number,
      updatedAt: row[7] as number,
    };
  } catch (error) {
    console.error("Failed to get local wallet by address:", error);
    return null;
  }
}

/**
 * Set a wallet as active (deactivates all others)
 */
export async function setActiveWallet(walletId: number): Promise<boolean> {
  try {
    const db = await getDb();
    const now = Date.now();

    // Deactivate all wallets
    db.run(`UPDATE local_wallets SET is_active = 0, updated_at = ?`, [now]);

    // Activate the specified wallet
    db.run(`UPDATE local_wallets SET is_active = 1, updated_at = ? WHERE id = ?`, [now, walletId]);

    await saveBytes(db.export());
    return true;
  } catch (error) {
    console.error("Failed to set active wallet:", error);
    return false;
  }
}

/**
 * Update wallet name
 */
export async function updateWalletName(walletId: number, name: string): Promise<boolean> {
  try {
    const db = await getDb();
    const now = Date.now();

    db.run(`UPDATE local_wallets SET name = ?, updated_at = ? WHERE id = ?`, [name, now, walletId]);

    await saveBytes(db.export());
    return true;
  } catch (error) {
    console.error("Failed to update wallet name:", error);
    return false;
  }
}

/**
 * Delete a local wallet
 */
export async function deleteLocalWallet(walletId: number): Promise<boolean> {
  try {
    const db = await getDb();

    // Get the wallet to check if it's active
    const wallet = await getLocalWalletById(walletId);
    if (!wallet) return false;

    db.run(`DELETE FROM local_wallets WHERE id = ?`, [walletId]);

    // If deleted wallet was active, set first remaining wallet as active
    if (wallet.isActive) {
      const remaining = await getAllLocalWallets();
      if (remaining.length > 0) {
        await setActiveWallet(remaining[0].id);
      }
    }

    await saveBytes(db.export());
    return true;
  } catch (error) {
    console.error("Failed to delete local wallet:", error);
    return false;
  }
}

/**
 * Check if any local wallets exist
 */
export async function hasLocalWallets(): Promise<boolean> {
  try {
    const db = await getDb();
    const res = db.exec(`SELECT COUNT(*) FROM local_wallets`);

    if (!res.length || !res[0]?.values.length) return false;

    return (res[0].values[0][0] as number) > 0;
  } catch (error) {
    console.error("Failed to check for local wallets:", error);
    return false;
  }
}

/**
 * Get wallet count
 */
export async function getWalletCount(): Promise<number> {
  try {
    const db = await getDb();
    const res = db.exec(`SELECT COUNT(*) FROM local_wallets`);

    if (!res.length || !res[0]?.values.length) return 0;

    return res[0].values[0][0] as number;
  } catch (error) {
    console.error("Failed to get wallet count:", error);
    return 0;
  }
}

/**
 * Export wallet data (encrypted mnemonic) for backup
 */
export async function exportWalletData(walletId: number): Promise<{
  name: string;
  address: string;
  encryptedMnemonic: string;
  exportedAt: string;
} | null> {
  try {
    const wallet = await getLocalWalletById(walletId);
    if (!wallet) return null;

    return {
      name: wallet.name,
      address: wallet.address,
      encryptedMnemonic: wallet.encryptedMnemonic,
      exportedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Failed to export wallet data:", error);
    return null;
  }
}

/**
 * Import wallet from exported data
 */
export async function importWalletFromBackup(
  data: { name: string; encryptedMnemonic: string },
  mnemonic: string,
  passwordHash: string
): Promise<LocalWallet | null> {
  try {
    // The mnemonic is needed to verify and derive the address
    const address = await deriveAddressFromMnemonic(mnemonic);

    const db = await getDb();

    // Check if wallet with this address already exists
    const existing = db.exec(
      `SELECT id FROM local_wallets WHERE address = ?`,
      [address]
    );

    if (existing.length > 0 && existing[0]?.values.length > 0) {
      throw new Error("A wallet with this address already exists");
    }

    // Re-encrypt with the new password
    const { encryptMnemonic } = await import("./crypto");
    const newEncryptedMnemonic = encryptMnemonic(mnemonic, passwordHash);

    const now = Date.now();
    db.run(
      `INSERT INTO local_wallets (name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at) 
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [data.name, address, newEncryptedMnemonic, passwordHash, now, now]
    );

    await saveBytes(db.export());

    return getLocalWalletByAddress(address);
  } catch (error) {
    console.error("Failed to import wallet from backup:", error);
    throw error;
  }
}

/**
 * Import wallet from encrypted backup (preserves original encryption)
 * No password needed - wallet is imported with its original encryption
 */
export async function importWalletFromEncryptedBackup(
  data: {
    name: string;
    address: string;
    encryptedMnemonic: string;
    passwordHash: string;
  }
): Promise<LocalWallet | null> {
  try {
    const db = await getDb();

    // Check if wallet with this address already exists
    const existing = db.exec(
      `SELECT id FROM local_wallets WHERE address = ?`,
      [data.address]
    );

    if (existing.length > 0 && existing[0]?.values.length > 0) {
      throw new Error("A wallet with this address already exists");
    }

    // If this is the first wallet, make it active
    const walletCount = db.exec(`SELECT COUNT(*) FROM local_wallets`);
    const isFirst =
      walletCount.length === 0 ||
      (walletCount[0]?.values[0]?.[0] as number) === 0;

    const now = Date.now();
    db.run(
      `INSERT INTO local_wallets (name, address, encrypted_mnemonic, passcode_hash, is_active, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.address,
        data.encryptedMnemonic,
        data.passwordHash,
        isFirst ? 1 : 0,
        now,
        now,
      ]
    );

    await saveBytes(db.export());

    return getLocalWalletByAddress(data.address);
  } catch (error) {
    console.error("Failed to import wallet from encrypted backup:", error);
    throw error;
  }
}
