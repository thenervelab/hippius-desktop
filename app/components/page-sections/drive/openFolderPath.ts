import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

type ParamGetter = Parameters<typeof generateFolderUrl>[1];

const nfc = (name: string | null | undefined) => (name ?? "").normalize("NFC");

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
  // Names are compared as they are, spaces included ("Notes " is its own
  // folder), and in one Unicode form: macOS hands out decomposed (NFD)
  // names, so "Café" typed and "Café" listed can differ byte for byte.
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const first = nfc(parts[0]);
  const row = rows.find((f) => f.isFolder && (nfc(f.actualFileName) === first || nfc(f.name) === first));
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

/**
 * A folder to step into once the drive's rows have loaded ("Show in folder"
 * on a capture). `missedOn` is the listing it was last looked for in.
 */
export interface PendingFolder {
  path: string;
  missedOn: readonly FormattedUserFile[] | null;
}

/**
 * What to do with a pending folder given the listing now on screen: go to
 * it when it is there; when it is not, wait for ONE refresh of the listing
 * before giving up. The first capture into a drive creates its Captures
 * folder, and the listing that opens first can predate it.
 */
export function resolvePendingFolder(
  pending: PendingFolder,
  rows: readonly FormattedUserFile[],
  getParam: ParamGetter,
): { url: string | null; pending: PendingFolder | null } {
  const url = folderUrlForPath(rows, pending.path, getParam);
  if (url) return { url, pending: null };
  if (pending.missedOn === null) return { url: null, pending: { ...pending, missedOn: rows } };
  if (pending.missedOn === rows) return { url: null, pending };
  return { url: null, pending: null };
}

/**
 * Whether the Drive page should open the folder its URL asks for
 * (`openLabel`, `openRemote`, `openSubfolder`, and `openFile`, the file to
 * point out in it), keyed on the request rather
 * than the mount: the page stays mounted across "Show in folder" clicks, so a
 * mount-once guard left every click after the first dead. The page clears the
 * params once it has opened the folder, which is what lets the same folder be
 * asked for again later. `key` is what to remember as handled (null once the
 * params are gone).
 */
export function shouldOpenFromUrl(
  lastHandled: string | null,
  request: { label: string | null; remote: boolean; subfolder: string | null; file?: string | null },
): { open: boolean; key: string | null } {
  if (!request.label) return { open: false, key: null };
  const key = JSON.stringify([request.label, request.remote, request.subfolder ?? "", request.file ?? ""]);
  return { open: key !== lastHandled, key };
}
