import { readFile, writeFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import JSZip from "jszip";
import { DB_FILENAME } from "./hippiusDesktopDB";
import { invoke } from "@tauri-apps/api/core";
import { saveBackendData } from "./backendDataDb";
import { getWalletRecord } from "./hippiusDesktopDB";
import { hashPasscode } from "./crypto";



export interface BackendData {
  public_sync_path: string;
  private_sync_path: string;
  encryption_keys: string[];
}

/**
 * Fetch data from backend using Tauri invoke command
 */
export async function fetchBackendData(): Promise<BackendData> {
  try {
    // Call the Tauri command to fetch backend data
    const data = await invoke<BackendData>('export_app_data');
    console.log("app data", data);
    return data;
  } catch (error) {
    console.error('Failed to fetch backend data:', error);
    throw new Error('Failed to fetch backend data');
  }
}

/**
 * Validates the given passcode against the stored passcode hash
 */
async function validatePasscode(passcode: string): Promise<boolean> {
  const walletRecord = await getWalletRecord();
  if (!walletRecord) {
    throw new Error("No wallet record found");
  }
  return hashPasscode(passcode) === walletRecord.passcodeHash;
}

/**
 * Exports the Hippius database as a zip file including backend data
 * @param passcode Optional passcode to fetch and encrypt backend data before export
 */
export async function exportHippiusDBDataAsZip(passcode?: string): Promise<boolean> {
  try {
    // If passcode is provided, fetch and store backend data first
    if (passcode) {
      // Validate the passcode
      const isValid = await validatePasscode(passcode);
      if (!isValid) {
        throw new Error("Invalid passcode");
      }

      // Fetch data from backend
      const backendData = await fetchBackendData();

      console.log("Fetched backend data:", backendData);

      // Save to local database with encryption
      await saveBackendData(backendData, passcode);
    }

    // Now read the database file which includes the newly saved backend data
    const dbBytes = await readFile(DB_FILENAME, {
      baseDir: BaseDirectory.AppLocalData,
    });

    // Create a new zip file
    const zip = new JSZip();
    zip.file("hippius-desktop.db", dbBytes);

    // Generate the zip blob
    const zipBlob = await zip.generateAsync({ type: "uint8array" });

    // Show save dialog
    const filePath = await save({
      filters: [
        {
          name: "Zip Archive",
          extensions: ["zip"],
        },
      ],
      defaultPath: "hippius-backup.zip",
    });

    if (filePath) {
      // Save the zip file
      await writeFile(filePath, zipBlob);
      return true;
    }



    return false;
  } catch (error) {
    console.error("Failed to export wallet:", error);
    throw error;
  }
}
