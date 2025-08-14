import JSZip from "jszip";
import { hashPasscode, decryptMnemonic } from "./crypto";
import { isMnemonicValid } from "./validateMnemonic";
import { saveBytes } from "./hippiusDesktopDB";
import initSqlJs from "sql.js/dist/sql-wasm.js";
import { invoke } from "@tauri-apps/api/core";

export async function restoreWalletFromZip(
  zipFile: File,
  passcode: string
): Promise<{ success: boolean; error?: string; mnemonic?: string }> {
  try {
    // Read the zip file
    const zipBuffer = await zipFile.arrayBuffer();
    const zip = new JSZip();
    const zipContents = await zip.loadAsync(zipBuffer);

    // Check if hippius-desktop.db exists in the zip
    const dbFile = zipContents.file("hippius-desktop.db");
    if (!dbFile) {
      return {
        success: false,
        error: "Invalid backup file: File not found",
      };
    }

    // Extract the database file
    const dbBytes = await dbFile.async("uint8array");

    // Initialize SQL.js and load the database
    const SQL = await initSqlJs({ locateFile: () => "/sql-wasm.wasm" });
    const db = new SQL.Database(dbBytes);

    // Get the wallet record from the database
    const res = db.exec(
      "SELECT encryptedMnemonic, passcodeHash FROM wallet ORDER BY id DESC LIMIT 1"
    );

    if (!res[0]?.values.length) {
      return { success: false, error: "No wallet data found in backup file" };
    }

    const [encryptedMnemonic, storedPasscodeHash] = res[0]
      .values[0] as string[];

    // Verify the passcode
    const inputPasscodeHash = hashPasscode(passcode);
    if (inputPasscodeHash !== storedPasscodeHash) {
      return { success: false, error: "Incorrect passcode" };
    }

    // Decrypt the mnemonic
    const mnemonic = decryptMnemonic(encryptedMnemonic, passcode);
    if (!isMnemonicValid(mnemonic)) {
      return { success: false, error: "Failed to decrypt wallet data" };
    }

    // Save the database file to the app directory
    await saveBytes(dbBytes);

    return { success: true, mnemonic };
  } catch (error) {
    console.error("Failed to restore wallet:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to restore wallet backup",
    };
  }
}

// Types and helper to call the Tauri command `import_app_data`
export type ImportDataParams = {
  public_sync_path?: string | null;
  private_sync_path?: string | null;
  encryption_keys: string[]; // base64 encoded keys
};

export async function importAppData(params: ImportDataParams): Promise<string> {
  // Calls the Rust command: #[tauri::command] pub async fn import_app_data(params: ImportDataParams)
  // Returns Ok(String) on success, throws on Err(String)
  return await invoke<string>("import_app_data", { params });
}
