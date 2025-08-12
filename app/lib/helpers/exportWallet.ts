import { readFile, writeFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
import JSZip from "jszip";
import { DB_FILENAME } from "./walletDb";

export async function exportWalletAsZip(): Promise<boolean> {
  try {
    // Read the wallet database file
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
    return false;
  }
}
