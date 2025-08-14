import { initHippiusDesktopDB, saveBytes } from "./hippiusDesktopDB";
import { encryptMnemonic, decryptMnemonic } from "./crypto";
import { BackendData } from "./exportHippiusDB";

const TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS backend_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data_type TEXT NOT NULL,
    encrypted_data TEXT NOT NULL,
    last_updated INTEGER NOT NULL
  );
`;

/**
 * Ensures the backend_data table exists in the database
 */
async function ensureBackendDataTable() {
    const db = await initHippiusDesktopDB();
    db.run(TABLE_SCHEMA);
    await saveBytes(db.export());
    return db;
}

/**
 * Save backend data to the database, encrypted with user's passcode
 */
export async function saveBackendData(data: BackendData, passcode: string): Promise<void> {
    const db = await ensureBackendDataTable();

    // Clear the backend_data table before saving new record
    db.run(`DELETE FROM backend_data`);

    // Convert data to string for encryption
    const dataString = JSON.stringify(data);

    // Encrypt the data using the same method as mnemonic encryption
    const encryptedData = encryptMnemonic(dataString, passcode);

    // Save to database
    db.run(
        `INSERT INTO backend_data (data_type, encrypted_data, last_updated)
         VALUES (?, ?, ?)`,
        ['main', encryptedData, Date.now()]
    );

    await saveBytes(db.export());
    console.log("Backend data table cleared and new data saved successfully");
}

/**
 * Retrieve and decrypt backend data
 */
export async function getBackendData(passcode: string): Promise<BackendData | null> {
    const db = await ensureBackendDataTable();

    const result = db.exec(`SELECT encrypted_data FROM backend_data WHERE data_type = 'main'`);

    if (!result.length || !result[0]?.values.length) {
        console.log("No backend data found in database");
        return null;
    }

    try {
        const encryptedData = result[0].values[0][0] as string;
        console.log("Found encrypted backend data:", {
            length: encryptedData.length,
            isEncrypted: encryptedData.includes(":")
        });

        const decryptedData = decryptMnemonic(encryptedData, passcode);
        const parsedData = JSON.parse(decryptedData) as BackendData;

        console.log("Successfully decrypted backend data:");
        console.log("- Public sync path available:", parsedData.public_sync_path);
        console.log("- Private sync path available:", parsedData.private_sync_path);
        console.log("- Number of encryption keys:", parsedData.encryption_keys);

        return parsedData;
    } catch (error) {
        console.error("Failed to decrypt backend data:", error);
        throw new Error("Failed to decrypt backend data");
    }
}