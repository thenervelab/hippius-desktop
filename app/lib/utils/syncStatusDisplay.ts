/** File-glob excluded rows — the Excluded chip, not Hidden. */
export function isExcludedSyncStatus(
  syncStatus: string | undefined,
): boolean {
  return syncStatus === "excluded";
}

/**
 * Bytes omitted from File No (H-045 / H-063). Size cells must show "—"
 * so they cannot disagree with the folder header.
 */
export function omitsBilledSize(syncStatus: string | undefined): boolean {
  return syncStatus === "excluded" || syncStatus === "hidden";
}
