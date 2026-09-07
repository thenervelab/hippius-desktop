/**
 * Mirror of Rust's `sync::failure_repo::FileFailureRecord` (camelCase via serde).
 * One persisted per-file sync failure, returned by the `get_drive_failures` IPC.
 *
 * `kind` is the stable discriminant the FE switches on (it mirrors the serde tag
 * of the Rust `FileFailureKindPayload`, NOT the English message text). The typed
 * detail fields are populated only for the variant that carries them.
 */
export type FileFailureKind =
  | "insufficientBalance"
  | "serverError"
  | "network"
  /** The file's bytes changed between the scan hash and the encrypt hash, so
   *  the engine discarded the upload. Retries itself on the next cycle. */
  | "changedWhileUploading"
  /** Local file vanished between plan and open (ENOENT). Next cycle drops it. */
  | "gone"
  | "other";

export interface FileFailureRecord {
  label: string;
  relativePath: string;
  fileName: string;
  /** One of {@link FileFailureKind}; typed loosely so an unknown future
   *  Rust variant degrades to the "other" branch instead of throwing. */
  kind: FileFailureKind | string;
  message: string | null;
  httpStatus: number | null;
  balanceCents: number | null;
  requiredCents: number | null;
  failureCount: number;
  /** Epoch millis of the most recent failure. */
  lastFailedAt: number;
}
