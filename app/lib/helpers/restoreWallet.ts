import JSZip from "jszip";
import { hashPasscode, decryptMnemonic } from "./crypto";
import { isMnemonicValid } from "./validateMnemonic";
import { saveBytes } from "./hippiusDesktopDB";
import initSqlJs from "sql.js/dist/sql-wasm.js";
import { invoke } from "@tauri-apps/api/core";
import { getBackendData } from "./backendDataDb";
import { BackendData } from "./exportHippiusDB";

/**
 * Imports backend data to the Tauri backend
 * @param backendData The decrypted backend data to import
 * @returns Success flag and any error message
 */
export async function importBackendData(backendData: BackendData): Promise<{ success: boolean; error?: string }> {
  try {
    console.log("Importing backend data to Tauri backend:");
    console.log("- Public sync path:", backendData.public_sync_path);
    console.log("- Private sync path:", backendData.private_sync_path);
    console.log("- Number of encryption keys:", backendData.encryption_keys);

    // Send the backend data to the Tauri backend using the invoke function
    console.log("Sending backend data to Tauri backend:", {
      publicSyncPath: backendData.public_sync_path,
      privateSyncPath: backendData.private_sync_path,
      encryptionKeys: backendData.encryption_keys,
    });
    await invoke('import_app_data', {
      publicSyncPath: backendData.public_sync_path,
      privateSyncPath: backendData.private_sync_path,
      encryptionKeys: backendData.encryption_keys,
    });

    console.log("Backend data imported successfully");
    return { success: true };
  } catch (error) {
    console.error("Failed to import backend data:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to import backend data"
    };
  }
}

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

    // Get and import backend data if available
    try {
      const backendData = await getBackendData(passcode);
      if (backendData) {
        console.log("Found backend data in the restored backup");
        const importResult = await importBackendData(backendData);
        if (!importResult.success) {
          console.error("Backend data import warning:", importResult.error);
          // We continue with restoration even if backend data import fails
        }
      } else {
        console.log("No backend data found in the restored backup");
      }
    } catch (backendError) {
      console.error("Backend data processing error:", backendError);
      // Continue with wallet restoration even if backend data processing fails
    }

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
