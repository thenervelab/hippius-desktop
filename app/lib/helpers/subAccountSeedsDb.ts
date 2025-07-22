import { initWalletDb, saveBytes, getWalletRecord } from "./walletDb";
import { encryptMnemonic, decryptMnemonic, hashPasscode } from "./crypto";

const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sub_account_seeds (
    address TEXT PRIMARY KEY,
    encrypted_seed TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

// Ensure the sub_account_seeds table exists in the wallet database
async function ensureSubAccountSeedsTable() {
    const db = await initWalletDb();
    db.run(TABLE_SCHEMA);
    await saveBytes(db.export());
    return db;
}

/**
 * Save a sub account's seed phrase, encrypted with the user's passcode
 */
export async function saveSubAccountSeed(address: string, seed: string, passcode: string) {
    // Validate that the passcode matches the user's stored passcode
    const walletRecord = await getWalletRecord();
    if (!walletRecord) {
        throw new Error("No wallet record found");
    }

    if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
        throw new Error("Incorrect passcode");
    }

    const encryptedSeed = encryptMnemonic(seed, passcode);

    const db = await ensureSubAccountSeedsTable();

    const existing = db.exec(`SELECT address FROM sub_account_seeds WHERE address = '${address}'`);

    if (existing.length > 0 && existing[0]?.values.length > 0) {
        db.run(`UPDATE sub_account_seeds SET encrypted_seed = ? WHERE address = ?`, [
            encryptedSeed, address
        ]);
    } else {
        db.run(`INSERT INTO sub_account_seeds (address, encrypted_seed, created_at) VALUES (?, ?, ?)`, [
            address, encryptedSeed, Date.now()
        ]);
    }

    await saveBytes(db.export());
}

/**
 * Retrieve and decrypt a sub account's seed phrase
 */
export async function getSubAccountSeed(address: string, passcode: string): Promise<string> {
    const walletRecord = await getWalletRecord();
    if (!walletRecord) {
        throw new Error("No wallet record found");
    }

    if (hashPasscode(passcode) !== walletRecord.passcodeHash) {
        throw new Error("Incorrect passcode");
    }

    const db = await ensureSubAccountSeedsTable();

    const result = db.exec(`SELECT encrypted_seed FROM sub_account_seeds WHERE address = '${address}'`);

    if (!result.length || !result[0]?.values.length) {
        throw new Error("No seed found for this sub account");
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
 * Check if a seed exists for the given sub account address
 */
export async function hasSubAccountSeed(address: string): Promise<boolean> {
    const db = await ensureSubAccountSeedsTable();

    const result = db.exec(`SELECT address FROM sub_account_seeds WHERE address = '${address}'`);

    return result.length > 0 && result[0]?.values.length > 0;
}

/**
 * Delete a sub account's seed
 */
export async function deleteSubAccountSeed(address: string): Promise<void> {
    const db = await ensureSubAccountSeedsTable();

    db.run(`DELETE FROM sub_account_seeds WHERE address = ?`, [address]);

    await saveBytes(db.export());
}

/**
 * List all sub account addresses that have seeds
 */
export async function listSubAccountsWithSeeds(): Promise<string[]> {
    const db = await ensureSubAccountSeedsTable();

    const result = db.exec(`SELECT address FROM sub_account_seeds ORDER BY created_at DESC`);

    if (!result.length || !result[0]?.values.length) {
        return [];
    }

    return result[0].values.map(row => row[0] as string);
}
