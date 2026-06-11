import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

/**
 * Unified "upload feed" shared by the Recent Files section and the tray
 * popover. It overlays the live sync snapshot (this device, currently
 * uploading / failed) on top of the account-wide "last uploads" the search
 * palette uses (`get_recent_uploads` → the HCFS `/search_files` endpoint).
 *
 * Both inputs are computed in Rust; this module is a deterministic join only:
 * it dedups, classifies, orders, and caps. It lives on the frontend (rather
 * than a Rust command) for two reasons the project rule tolerates:
 *   1. the tray popover webview mounts no app providers, so it can only talk
 *      to the backend through raw `invoke`/`listen` — there is no react-query
 *      cache or Jotai store to host a server hook; and
 *   2. the live progress arrives as a ~4/sec event stream, so re-running a
 *      server-hitting Rust merge on every tick would hammer `/search_files`.
 *
 * Keeping it pure makes it unit-testable and identical across both surfaces.
 */
export type UploadFeedStatus = "uploading" | "pending" | "failed" | "completed";

/**
 * One row of the feed. It is a superset of `FormattedUserFile` so the Recent
 * Files Drive table can render it unchanged (the table reads `syncStatus` and
 * pulls live progress from the snapshot via `useFileLiveProgress`). The extra
 * `feedStatus` / `progressPercent` / `errorMessage` fields let the tray popover
 * — which renders its own list, not the Drive table — show progress and errors
 * without re-deriving them from the snapshot.
 */
export type UploadFeedItem = FormattedUserFile & {
  feedStatus: UploadFeedStatus;
  progressPercent?: number;
  errorMessage?: string;
};

export interface MergeUploadFeedParams {
  /** Account-wide completed uploads (newest-first), from `get_recent_uploads`. */
  recentUploads: FormattedUserFile[];
  /** Live per-file progress for the current sync session (`SyncSnapshot.files`). */
  snapshotFiles: FileProgress[];
  /** Hard cap on the returned rows (Recent Files: 50, tray popover: 20). */
  limit: number;
}

/**
 * Ordering rank — drives the "uploading first, then failed, then completed"
 * grouping the product asked for. Within a rank the input order is preserved
 * (stable sort): live rows keep snapshot order, completed rows keep the
 * server's newest-first order.
 */
function rankOf(status: UploadFeedStatus): number {
  switch (status) {
    case "uploading":
    case "pending":
      return 0;
    case "failed":
      return 1;
    case "completed":
      return 2;
  }
}

/** Dedup identity: a file is the same row whether it's mid-upload (snapshot)
 *  or already on the server (recent uploads). Keyed by drive label + the
 *  sync-root-relative path, falling back to the display name. */
function dedupKey(file: {
  label?: string;
  actualFileName?: string;
  name: string;
}): string {
  return `${file.label ?? ""}::${file.actualFileName || file.name}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const last = trimmed.split("/").pop();
  return last && last.length > 0 ? last : trimmed;
}

/** Map a live snapshot upload entry onto a feed row. Only upload-direction
 *  files reach here (downloads/deletes are not "uploads"). `actualFileName`
 *  is set to the snapshot `path` so the Drive table's `useFileLiveProgress`
 *  matches the row back to its live progress. */
function snapshotToItem(fp: FileProgress): UploadFeedItem {
  const actualFileName = fp.path || fp.fileName;
  const name = basename(fp.fileName || fp.path);

  let feedStatus: UploadFeedStatus;
  let syncStatus: FormattedUserFile["syncStatus"];
  switch (fp.status) {
    case "error":
      feedStatus = "failed";
      syncStatus = "failed";
      break;
    case "completed":
      feedStatus = "completed";
      syncStatus = "synced";
      break;
    case "pending":
      feedStatus = "pending";
      syncStatus = "pending";
      break;
    // inProgress / encrypting both read as an active upload to the user.
    default:
      feedStatus = "uploading";
      syncStatus = "uploading";
  }

  return {
    name,
    actualFileName,
    size: fp.totalBytes,
    createdAt: Date.now(),
    arionHash: "",
    arionCid: "",
    minerIds: [],
    isAssigned: false,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    source: "",
    isFolder: false,
    type: "private",
    syncStatus,
    label: fp.label,
    feedStatus,
    progressPercent: fp.progressPercent,
    errorMessage: fp.error,
  };
}

/**
 * Build the unified upload feed.
 *
 * Order: active uploads (uploading/pending), then failed, then completed
 * (a just-finished file from the snapshot sorts above the server's
 * newest-first completed list). Live snapshot rows win over server rows on a
 * dedup-key collision, so a file mid-upload never also appears as "completed".
 * The result is capped to `limit`.
 */
export function mergeUploadFeed({
  recentUploads,
  snapshotFiles,
  limit,
}: MergeUploadFeedParams): UploadFeedItem[] {
  // Server rows carry the real upload time. A completed live snapshot row is
  // re-stamped `createdAt: Date.now()` on every merge (FileProgress has no
  // timestamp), so a just-finished file that lingers in the snapshot would
  // render "Just now" forever. Once the server list includes that file, drop
  // the completed live row and let the server row (real time) represent it.
  // Live rows for in-flight states (uploading / pending / failed) always win —
  // they carry progress/error the server list can't show yet.
  const serverByKey = new Map(recentUploads.map((f) => [dedupKey(f), f]));

  const liveItems = snapshotFiles
    .filter((f) => f.action === "upload")
    .map(snapshotToItem)
    .filter(
      (item) =>
        !(item.feedStatus === "completed" && serverByKey.has(dedupKey(item))),
    )
    .sort((a, b) => rankOf(a.feedStatus) - rankOf(b.feedStatus));

  const seen = new Set<string>();
  const ordered: UploadFeedItem[] = [];

  for (const item of liveItems) {
    const key = dedupKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(item);
  }

  for (const file of recentUploads) {
    const key = dedupKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push({
      ...file,
      syncStatus: file.syncStatus ?? "synced",
      feedStatus: "completed",
    });
  }

  return ordered.slice(0, Math.max(0, limit));
}
