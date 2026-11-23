import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

export type ExportCsvOutcome = "saved" | "cancelled";

/**
 * Export CSV: asks where to save with the native dialog (the UI half, as for
 * chat attachments and downloads; a `blob:` link does nothing in the Tauri
 * webview), then hands the rest to Rust, which reads the viewers, builds the
 * file and writes it. A dismissed dialog is `"cancelled"`, not an error.
 */
export async function saveInsightsCsv(shareToken: string, fileName: string): Promise<ExportCsvOutcome> {
  const name = await insightsCsvName(fileName);
  const destination = await save({
    defaultPath: await inDownloads(name),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!destination) return "cancelled";
  await exportInsightsCsv(shareToken, fileName, destination);
  return "saved";
}

/** `~/Downloads/<name>` when the platform says where that is, else the name. */
export async function inDownloads(name: string): Promise<string> {
  try {
    const { downloadDir, join } = await import("@tauri-apps/api/path");
    return await join(await downloadDir(), name);
  } catch {
    return name;
  }
}

/** The name the save dialog suggests for a link's activity CSV, dated today. */
function insightsCsvName(fileName: string): Promise<string> {
  return invoke<string>("share_insights_csv_name", { fileName });
}

/**
 * Rust reads the link's viewers again, builds the CSV (the console's
 * columns, formula-safe cells) and writes it to `destination`. Kept out of
 * `lib/tauri/shareInsights.ts`, which the capture windows import: a save is
 * main-window only (`ipc_guard.rs`).
 */
function exportInsightsCsv(shareToken: string, fileName: string, destination: string): Promise<void> {
  return invoke<void>("share_export_insights_csv", { shareToken, fileName, destination });
}
