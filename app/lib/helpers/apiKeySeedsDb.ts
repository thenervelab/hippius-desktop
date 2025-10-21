import { initHippiusDesktopDB, saveBytes, getWalletRecord } from "./hippiusDesktopDB";
import { encryptMnemonic, decryptMnemonic, hashPasscode } from "./crypto";

const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS api_key_seeds (
    address TEXT PRIMARY KEY,
    encrypted_seed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

// Ensure the api_key_seeds table exists in the wallet database
async function ensureApiKeySeedsTable() {
    const db = await initHippiusDesktopDB();
    db.run(TABLE_SCHEMA);
    await saveBytes(db.export());
    return db;
}

/**
 * Save a api key's seed phrase, encrypted with the user's passcode
 */
export async function saveApiKeySeed(address: string, seed: string, passcode: string) {
    // Validate that the passcode matches the user's stored passcode
    const walletRecord = await getWalletRecord();
    if (!walletRecord) {
        throw new Error("No wallet record found");
    }

    if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
        throw new Error("Incorrect passcode");
    }

    const encryptedSeed = encryptMnemonic(seed, passcode);

    const db = await ensureApiKeySeedsTable();

    const existing = db.exec(`SELECT address FROM api_key_seeds WHERE address = '${address}'`);

    if (existing.length > 0 && existing[0]?.values.length > 0) {
        db.run(`UPDATE api_key_seeds SET encrypted_seed = ? WHERE address = ?`, [
            encryptedSeed, address
        ]);
    } else {
        db.run(`INSERT INTO api_key_seeds (address, encrypted_seed, created_at) VALUES (?, ?, ?)`, [
            address, encryptedSeed, Date.now()
        ]);
    }

    await saveBytes(db.export());
}

/**
 * Retrieve and decrypt a api key's seed phrase
 */
export async function getApiKeySeed(address: string, passcode: string): Promise<string> {
    const walletRecord = await getWalletRecord();
    if (!walletRecord) {
        throw new Error("No wallet record found");
    }

    if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
        throw new Error("Incorrect passcode");
    }

    const db = await ensureApiKeySeedsTable();

    const result = db.exec(`SELECT encrypted_seed FROM api_key_seeds WHERE address = '${address}'`);

    if (!result.length || !result[0]?.values.length) {
        throw new Error("No seed found for this api key");
    }

    try {
        const encryptedSeed = result[0].values[0][0] as string;
        return decryptMnemonic(encryptedSeed, passcode);
    } catch (error) {
        console.error("Failed to decrypt seed:", error);
        throw new Error("Failed to decrypt seed");
    }
}

/**
 * Check if a seed exists for the given api key address
 */
export async function hasApiKeySeed(address: string): Promise<boolean> {
    const db = await ensureApiKeySeedsTable();

    const result = db.exec(`SELECT address FROM api_key_seeds WHERE address = '${address}'`);

    return result.length > 0 && result[0]?.values.length > 0;
}

/**
 * Delete a api key's seed
 */
export async function deleteApiKeySeed(address: string): Promise<void> {
    const db = await ensureApiKeySeedsTable();

    db.run(`DELETE FROM api_key_seeds WHERE address = ?`, [address]);

    await saveBytes(db.export());
}

/**
 * List all api key addresses that have seeds
 */
export async function listApiKeysWithSeeds(): Promise<string[]> {
    const db = await ensureApiKeySeedsTable();

    const result = db.exec(`SELECT address FROM api_key_seeds ORDER BY created_at DESC`);

    if (!result.length || !result[0]?.values.length) {
        return [];
    }

    return result[0].values.map(row => row[0] as string);
}
