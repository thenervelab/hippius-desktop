/**
 * Arion content hash for File Details and Hipstats.
 *
 * Desktop listings split two hashes onto historically-named fields:
 * - `arionHash` is the path id (`blake3(relative_path)` hex)
 * - `arionCid` is the Arion BLAKE3 content digest (server `arion_hash`)
 *
 * File Details and "View on Explorer" must use this helper so they never
 * display or link the path id as the file's hash. No fallback to `arionHash`.
 */
export function arionContentHash(file: {
  arionCid?: string | null;
  isFolder?: boolean;
}): string | null {
  if (file.isFolder) return null;
  const cid = file.arionCid?.trim() ?? "";
  if (!cid || cid === "pending") return null;
  return cid;
}

export function fileTrackerUrl(hash: string): string {
  return `https://hipstats.com/file-tracker/${hash}`;
}

/**
 * `arion_hash` argument for `cache_remote_file` / `get_thumbnail`.
 *
 * Those commands treat a non-empty value as the content-addressed cache
 * filename so an edit cannot serve a stale decrypt. Pass the digest
 * (`arionCid`); empty lets Rust fall back to `file_id` (the path id).
 * Never pass `arionHash` — that field is the path id.
 */
export function previewCacheContentHash(file: {
  arionCid?: string | null;
  isFolder?: boolean;
}): string {
  return arionContentHash(file) ?? "";
}
