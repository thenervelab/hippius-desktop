/**
 * The drive-relative path of a FILE row in the Drive table, which keys its
 * persisted failure (and every per-file IPC).
 *
 * `entryName` is the row's `actualFileName` (or display name). It is already
 * the full path when it carries a `/` or starts with `basePath`; otherwise it
 * is a basename under the folder being shown (`basePath`, the subfolder path
 * or an inline-expanded folder's own path). Matching on the basename alone
 * would give every same-named file in the drive the first one's failure.
 *
 * Both are trimmed of leading and trailing slashes here, so every caller
 * gets the same key whether its folder path came from the URL (which may
 * carry them) or from the table's own normalized state.
 */
export function resolveRowRelativePath(basePath: string, entryName: string): string {
  const normalizedName = entryName.replace(/^\/+|\/+$/g, "");
  const folder = basePath.replace(/^\/+|\/+$/g, "");
  if (!folder) return normalizedName;
  if (normalizedName === folder || normalizedName.startsWith(`${folder}/`)) {
    return normalizedName;
  }
  if (normalizedName.includes("/")) return normalizedName;
  return `${folder}/${normalizedName}`;
}
