/**
 * Normalize a sync-root-relative path to the single canonical form used as a
 * cross-boundary identity key.
 *
 * The desktop joins two independently-produced views of the same file — the
 * live sync snapshot (`FileProgress.path`) and the server's "last uploads"
 * (`FormattedUserFile.actualFileName`) — by relative path. The server mapper
 * trims a leading slash (Rust `recent_uploads.rs`: `trim_start_matches('/')`)
 * while macOS/APFS snapshot paths can arrive with one, so the two keys diverged
 * and a just-completed upload failed to dedup against its server row — it
 * re-stamped "Just now" forever, or was wrongly suppressed. Both sides MUST run
 * through this identical normalization or that identity breaks again.
 */
export function normalizeRelPath(path: string): string {
  return path.replace(/^\/+/, "");
}
