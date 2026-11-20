import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { inDownloads, type ExportCsvOutcome } from "./exportCsv";

/**
 * The NDA tab's Export: asks where to save with the native dialog, then Rust
 * reads every accept again, builds the CSV and writes it. A dismissed dialog
 * is `"cancelled"`, not an error. Main window only (`ipc_guard.rs`).
 */
export async function saveNdaAcceptsCsv(shareToken: string, fileName: string): Promise<ExportCsvOutcome> {
  const name = await invoke<string>("share_nda_accepts_csv_name", { fileName });
  const destination = await save({
    defaultPath: await inDownloads(name),
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (!destination) return "cancelled";
  await invoke<void>("share_export_nda_accepts_csv", { shareToken, fileName, destination });
  return "saved";
}

/**
 * One accept's Record: the file, the signer, the accept time in UTC and id,
 * and the full text with its SHA-256, built and written by Rust where the
 * owner chooses.
 */
export async function saveNdaRecord(shareToken: string, fileName: string, acceptId: number): Promise<ExportCsvOutcome> {
  const name = await invoke<string>("share_nda_record_name", { fileName, acceptId });
  const destination = await save({
    defaultPath: await inDownloads(name),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (!destination) return "cancelled";
  await invoke<void>("share_save_nda_record", { shareToken, fileName, acceptId, destination });
  return "saved";
}
