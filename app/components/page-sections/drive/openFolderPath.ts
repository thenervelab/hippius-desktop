import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

type ParamGetter = Parameters<typeof generateFolderUrl>[1];

/**
 * The Drive URL for `path` inside the drive whose root rows are `rows`, or
 * null when its first folder is not among them.
 *
 * The first level is the root row's own URL (`generateFolderUrl`, what a click
 * on it builds). Anything deeper keeps that URL's drive fields and names the
 * deeper folder the way a breadcrumb jump does.
 */
export function folderUrlForPath(
  rows: readonly FormattedUserFile[],
  path: string,
  getParam: ParamGetter,
): string | null {
  const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const row = rows.find((f) => f.isFolder && (f.actualFileName === parts[0] || f.name === parts[0]));
  if (!row) return null;
  const { url } = generateFolderUrl(row, getParam);
  if (parts.length === 1) return url;

  const params = new URLSearchParams(url.split("?")[1] ?? "");
  const last = parts[parts.length - 1];
  params.set("folderName", last);
  params.set("folderActualName", last);
  params.set("mainFolderActualName", parts[0]);
  params.set("subFolderPath", parts.join("/"));
  return `/files?${params.toString()}`;
}
