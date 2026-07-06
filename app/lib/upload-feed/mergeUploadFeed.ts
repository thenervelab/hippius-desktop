import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";
import { normalizeRelPath } from "@/app/lib/utils/relPath";

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
  /**
   * Completed uploads the caller has retained across merges with stable
   * timestamps, kept visible until the server list confirms them — see
   * {@link useRetainedCompletedUploads}. This bridges the window between a
   * just-finished file leaving `snapshotFiles` and the debounced server
   * refetch landing (the "appear then vanish" report). Defaults to none so the
   * pure function and its tests need not supply it.
   */
  retainedCompleted?: UploadFeedItem[];
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
 *  sync-root-relative path, falling back to the display name. The path is
 *  normalized so a leading-slash difference between the snapshot side and the
 *  server side can't split one file into two rows — see {@link normalizeRelPath}. */
export function dedupKey(file: {
  label?: string;
  actualFileName?: string;
  name: string;
}): string {
  return `${file.label ?? ""}::${normalizeRelPath(file.actualFileName || file.name)}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const last = trimmed.split("/").pop();
  return last && last.length > 0 ? last : trimmed;
}

/** Map a live snapshot upload entry onto a feed row. Only upload-direction
 *  files reach here (downloads/deletes are not "uploads"). `actualFileName`
 *  is set to the raw snapshot `path` (NOT normalized) so the Drive table's
 *  `useFileLiveProgress` matches the row back to its live progress, and
 *  `createdAt` is stamped at call time — a completed row must therefore be
 *  captured once with a stable stamp (see {@link useRetainedCompletedUploads})
 *  rather than re-mapped every merge, or it reads "Just now" forever. */
export function snapshotToItem(fp: FileProgress): UploadFeedItem {
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
  retainedCompleted = [],
  limit,
}: MergeUploadFeedParams): UploadFeedItem[] {
  const serverByKey = new Map(recentUploads.map((f) => [dedupKey(f), f]));

  const liveAll = snapshotFiles
    .filter((f) => f.action === "upload")
    .map(snapshotToItem);
  // In-flight + failed rows carry progress/error the server list can't show
  // yet, so they always win. Completed live rows are handled in the completed
  // group below (after retained rows) so a stable-stamped retained copy can
  // take precedence over the per-merge re-stamped snapshot copy.
  const liveActive = liveAll
    .filter((item) => item.feedStatus !== "completed")
    .sort((a, b) => rankOf(a.feedStatus) - rankOf(b.feedStatus));
  const liveCompleted = liveAll.filter(
    (item) => item.feedStatus === "completed",
  );

  const seen = new Set<string>();
  const ordered: UploadFeedItem[] = [];

  // 1. Active (uploading/pending) then failed.
  for (const item of liveActive) {
    const key = dedupKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(item);
  }

  // 2. Completed rows, in precedence: retained (stable timestamp, survives the
  //    window before the server refetch lands) → live-snapshot completed
  //    (fallback when no retention is wired) → server list (real upload time,
  //    pushed in step 3). A completed row the server already has is dropped so
  //    the server row represents it with the authoritative time.
  for (const item of [...retainedCompleted, ...liveCompleted]) {
    const key = dedupKey(item);
    if (seen.has(key) || serverByKey.has(key)) continue;
    seen.add(key);
    ordered.push(item);
  }

  // 3. Server completed list (newest-first), minus anything already shown.
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
