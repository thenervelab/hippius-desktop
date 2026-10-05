/**
 * The drive-relative path of a FILE row in the Drive table, which keys its
 * persisted failure (and every per-file IPC).
 *
 * `entryName` is the row's `actualFileName` (or display name). It is already
 * the full path when it carries a `/` or starts with `basePath`; otherwise it
 * is a basename under the folder being shown (`basePath`, the subfolder path
 * or an inline-expanded folder's own path). Matching on the basename alone
 * would give every same-named file in the drive the first one's failure.
 */
export function resolveRowRelativePath(basePath: string, entryName: string): string {
  const normalizedName = entryName.replace(/^\/+|\/+$/g, "");
  if (!basePath) return normalizedName;
  if (normalizedName === basePath || normalizedName.startsWith(`${basePath}/`)) {
    return normalizedName;
  }
  if (normalizedName.includes("/")) return normalizedName;
  return `${basePath}/${normalizedName}`;
}
