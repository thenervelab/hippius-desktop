import { save } from "@tauri-apps/plugin-dialog";

import { exportFolderInsightsCsv, folderInsightsCsvName } from "@/app/lib/tauri/folderInsights";

export type ExportCsvOutcome = "saved" | "cancelled";

/**
 * Export CSV for a folder link: asks where to save with the native dialog
 * (the UI half; a `blob:` link does nothing in the Tauri webview), then Rust
 * reads the activity again, builds the file and writes it. A dismissed
 * dialog is `"cancelled"`, not an error.
 */
export async function saveFolderInsightsCsv(tokenHash: string, folderName: string): Promise<ExportCsvOutcome> {
  const name = await folderInsightsCsvName(folderName);
  const destination = await save({
    defaultPath: await inDownloads(name),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!destination) return "cancelled";
  await exportFolderInsightsCsv(tokenHash, folderName, destination);
  return "saved";
}

/** `~/Downloads/<name>` when the platform says where that is, else the name. */
async function inDownloads(name: string): Promise<string> {
  try {
    const { downloadDir, join } = await import("@tauri-apps/api/path");
    return await join(await downloadDir(), name);
  } catch {
    return name;
  }
}
