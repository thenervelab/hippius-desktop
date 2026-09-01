import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

/**
 * What it takes to render a thumbnail for one file, resolved from its identity.
 *
 *  - `local`  — the plaintext file is already on disk. The hook still routes
 *    most local images through the Rust thumbnailer (disk-cached small JPEG,
 *    no network — see `rustThumbnailRequest`); `url` is the full-size asset
 *    url used for the formats and rows that keep the original.
 *  - `cloud`  — the file isn't on this device (uploaded from another device, or
 *    a folder not synced here). The bytes must be fetched + decrypted, so we
 *    hand the identifiers to the Rust `get_thumbnail` command, which downloads,
 *    thumbnails, caches the small JPEG, and discards the full copy.
 *  - `none`   — neither possible (no local copy AND missing the server id / drive
 *    label / account needed to fetch one); the caller shows the file-type icon.
 */
export type ThumbnailPlan =
  | { kind: "local"; url: string }
  | {
      kind: "cloud";
      accountId: string;
      label: string;
      fileId: string;
      arionHash: string;
      source: string | null;
    }
  | { kind: "none" };

/**
 * Decide how to obtain a file's thumbnail. Pure (no I/O) so the local-vs-cloud
 * branch — the crux of the cloud-thumbnail fix — is unit-testable in isolation.
 *
 * A file counts as local only when it has a real on-disk `source` AND wasn't
 * flagged `pending`: a `pending` hit carries the *would-be* local path but the
 * bytes aren't down yet, told apart from a still-uploading local row by carrying
 * a server `fileId`. This mirrors {@link useViewableFileUrl} so a file's
 * thumbnail and its full preview always agree on local-vs-cloud.
 */
export function planThumbnail(
  file: FormattedUserFile,
  polkadotAddress: string | null,
): ThumbnailPlan {
  const local = getFileUrl(file);
  const pendingCloud = file.syncStatus === "pending" && !!file.fileId;
  const onDisk = local.isLocal && !!local.url && !pendingCloud;
  if (onDisk) {
    return { kind: "local", url: local.url };
  }

  if (!file.fileId || !file.label || !polkadotAddress) {
    return { kind: "none" };
  }
  return {
    kind: "cloud",
    accountId: polkadotAddress,
    label: file.label,
    fileId: file.fileId,
    arionHash: file.arionHash ?? "",
    source: file.source ?? null,
  };
}

/**
 * FIFO slot pool bounding how many expensive thumbnail jobs run at once
 * (module-level: ONE pool of each kind across every mounted row).
 */
function createSlotPool(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (active < maxConcurrent) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(() => {
          active += 1;
          resolve();
        });
      });
    },
    release(): void {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

type SlotPool = ReturnType<typeof createSlotPool>;

/** Each cloud thumbnail downloads + decrypts the full file; keep it small. */
const cloudThumbnailPool = createSlotPool(3);

/**
 * Local thumbnails skip the network but are not free: a Rust `get_thumbnail`
 * cache miss decodes the full bitmap (off the WebView thread), and a local
 * HEIC runs a full wasm conversion in the WebView. Bound the in-view burst.
 */
const localThumbnailPool = createSlotPool(4);

export interface ThumbnailState {
  /** Asset-protocol URL for the thumbnail, or `null` while unresolved/unavailable. */
  url: string | null;
  /** True while a cloud thumbnail is being fetched + generated. */
  isLoading: boolean;
  error: string | null;
}

const IDLE: ThumbnailState = { url: null, isLoading: false, error: null };

interface MotionPhotoPreview {
  isLive: boolean;
  stillPath: string | null;
  videoPath: string | null;
}

function isHeicFileName(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension === "heic" || extension === "heif";
}

async function downscaleThumbnail(blob: Blob, maxDim: number): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return blob;

  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxDim / bitmap.width, maxDim / bitmap.height);
    if (scale >= 1) return blob;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob(
        (thumbnail) => resolve(thumbnail ?? blob),
        "image/jpeg",
        0.84,
      );
    });
  } finally {
    bitmap.close();
  }
}

/**
 * Local formats routed through the Rust `get_thumbnail` pipeline. Two rules
 * decide membership, and both must hold:
 *  - a JPEG thumbnail represents the format faithfully (png/gif/webp carry
 *    transparency or animation a JPEG flattens — an alpha-preserving Rust
 *    output would let png join; tracked as a follow-up);
 *  - the Rust `image` crate is BUILT with the decoder — Cargo.toml pins
 *    `features = ["jpeg", "png", "bmp"]`, so a tiff/avif/raw request is a
 *    guaranteed decode error that burns a pool slot per cell remount.
 * Everything else keeps the original asset url — bounded by the same
 * in-view gate.
 */
const RUST_THUMBNAIL_EXTENSIONS = new Set(["jpg", "jpeg", "bmp"]);

interface RustThumbnailRequest {
  accountId: string;
  label: string;
  fileId: string;
  arionHash: string;
  source: string | null;
}

/**
 * Decide whether a LOCAL image can use the Rust thumbnailer — the same
 * `get_thumbnail` command cloud thumbnails use. Rust short-circuits to the
 * on-disk copy (no network), decodes off the WebView thread, and disk-caches
 * the small JPEG by content hash, so re-browsing a folder is a cache hit.
 *
 * The gate keys on `arionHash` first, `fileId` as fallback — the same order
 * Rust derives its cache key. LOCAL listing rows NEVER carry a `fileId`
 * (`get_user_files` sets `file_id: ""`; the nested mapper sets it only for
 * remote rows), so requiring one turns this whole path into dead code for
 * the drive surfaces it exists for. A row with neither id (not yet
 * uploaded) returns `null` and keeps the original url. `label` is passed
 * through but not required: Rust only needs it for the cloud fallback when
 * the on-disk copy has vanished.
 */
function rustThumbnailRequest(
  file: FormattedUserFile,
  polkadotAddress: string | null,
): RustThumbnailRequest | null {
  const name = file.actualFileName || file.name;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (!RUST_THUMBNAIL_EXTENSIONS.has(extension)) return null;

  if ((!file.arionHash && !file.fileId) || !polkadotAddress) return null;
  return {
    accountId: polkadotAddress,
    label: file.label ?? "",
    fileId: file.fileId ?? "",
    arionHash: file.arionHash ?? "",
    source: file.source ?? null,
  };
}

/**
 * Resolved thumbnail urls by content key (`arionHash`/`fileId` + maxDim —
 * the same pair Rust's disk cache is keyed on). The virtualised filmstrip
 * unmounts cells as it scrolls; without this, every remount re-issues a
 * `get_thumbnail` IPC for a JPEG Rust already has on disk and flashes the
 * file-type icon until it returns. Only stable asset paths are cached —
 * never object URLs, which are revoked on unmount. FIFO-bounded so a long
 * session cannot grow it without limit.
 */
const RESOLVED_URL_CACHE_LIMIT = 8192;
const resolvedUrlCache = new Map<string, string>();

function resolvedUrlKey(arionHash: string, fileId: string, maxDim: number): string {
  return `${arionHash || fileId}:${maxDim}`;
}

/**
 * Drop a file's cached thumbnail url so the next in-view resolution asks
 * Rust again. Consumers call this from an `<img>` onError: the cached url
 * can point at a cache file that no longer exists (user cleanup, disk
 * tools), and Rust regenerates the JPEG on the next `get_thumbnail` —
 * without eviction the dead url is re-served for the rest of the session.
 */
export function evictResolvedThumbnailUrl(file: FormattedUserFile, maxDim: number): void {
  resolvedUrlCache.delete(resolvedUrlKey(file.arionHash ?? "", file.fileId ?? "", maxDim));
}

function cacheResolvedUrl(key: string, url: string): void {
  if (resolvedUrlCache.size >= RESOLVED_URL_CACHE_LIMIT) {
    const oldest = resolvedUrlCache.keys().next().value;
    if (oldest !== undefined) resolvedUrlCache.delete(oldest);
  }
  resolvedUrlCache.set(key, url);
}

/** Ask Rust for the cached (or freshly generated) thumbnail JPEG's path. */
async function fetchRustThumbnail(request: RustThumbnailRequest, maxDim: number): Promise<string> {
  const path = await invoke<string>("get_thumbnail", { ...request, maxDim });
  return convertFileSrc(path.replace(/\\/g, "/"));
}

/**
 * One lifecycle for every async thumbnail branch: mark loading, run the job
 * under its pool, publish the url, and make cancellation drop a late result
 * instead of painting it over the file now in the cell. `fallbackUrl`
 * (local files) degrades a failure to the original asset url — loudly, so a
 * platform-wide pipeline failure leaves a trail — while branches without one
 * surface the error state. Returns the effect cleanup.
 */
function runThumbnailJob(opts: {
  pool: SlotPool;
  job: () => Promise<string>;
  describe: string;
  fallbackUrl?: string;
  /** The job's url is an object URL that must be revoked when unused. */
  revokeOnDrop?: boolean;
  setState: (state: ThumbnailState) => void;
}): () => void {
  const { pool, job, describe, fallbackUrl, revokeOnDrop, setState } = opts;
  let cancelled = false;
  let objectUrl = "";

  setState({ url: null, isLoading: true, error: null });
  void (async () => {
    await pool.acquire();
    if (cancelled) {
      pool.release();
      return;
    }
    try {
      const url = await job();
      if (cancelled) {
        if (revokeOnDrop) URL.revokeObjectURL(url);
        return;
      }
      if (revokeOnDrop) objectUrl = url;
      setState({ url, isLoading: false, error: null });
    } catch (error: unknown) {
      if (cancelled) return;
      if (fallbackUrl) {
        console.warn(`useThumbnail: ${describe} failed; serving the original`, error);
        setState({ url: fallbackUrl, isLoading: false, error: null });
      } else {
        const message =
          typeof error === "string"
            ? error
            : ((error as { message?: string })?.message ?? `Failed to load ${describe}.`);
        setState({ url: null, isLoading: false, error: message });
      }
    } finally {
      pool.release();
    }
  })();

  return () => {
    cancelled = true;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
}

async function prepareHeicThumbnail(
  file: FormattedUserFile,
  plan: ThumbnailPlan,
  maxDim: number,
): Promise<string> {
  let sourcePath = file.source?.replace(/\\/g, "/") ?? "";
  let sourceUrl = plan.kind === "local" ? plan.url : "";

  if (plan.kind === "cloud") {
    sourcePath = (
      await invoke<string>("cache_remote_file", {
        accountId: plan.accountId,
        label: plan.label,
        fileId: plan.fileId,
        fileName: file.actualFileName || file.name,
        arionHash: plan.arionHash,
      })
    ).replace(/\\/g, "/");
    sourceUrl = convertFileSrc(sourcePath);
  }
  if (!sourcePath || !sourceUrl) {
    throw new Error("HEIC thumbnail source is unavailable");
  }

  // Reuse the native mobile-container parser so HEIC Live Photos thumbnail
  // only their still portion.
  const prepared = await invoke<MotionPhotoPreview>(
    "prepare_motion_photo_preview",
    { sourcePath },
  );
  if (prepared.isLive && prepared.stillPath) {
    sourceUrl = convertFileSrc(prepared.stillPath.replace(/\\/g, "/"));
  }

  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Could not read HEIC thumbnail (${response.status})`);
  }
  const { heicTo } = await import("heic-to/csp");
  const jpeg = await heicTo({
    blob: await response.blob(),
    type: "image/jpeg",
    quality: 0.88,
  });
  return URL.createObjectURL(await downscaleThumbnail(jpeg, maxDim));
}

/**
 * Resolve a thumbnail URL for a file shown in a card or the preview filmstrip,
 * uniformly for local AND cloud-only files (see {@link planThumbnail}).
 *
 * `enabled` gates EVERY branch — cloud fetches, HEIC conversion, and local
 * resolutions alike — so a grid or filmstrip doesn't fetch or decode every
 * item at once. Local images resolve through the Rust thumbnailer's small
 * disk-cached JPEG rather than the full-size original: an on-disk path is
 * free to serve but each mounted full-resolution <img> costs a full bitmap
 * decode, which is what froze the viewer on a 13k-photo folder.
 */
export function useThumbnail(
  file: FormattedUserFile | null,
  opts?: { enabled?: boolean; maxDim?: number },
): ThumbnailState {
  const enabled = opts?.enabled ?? true;
  const maxDim = opts?.maxDim ?? 256;
  const { polkadotAddress } = useWalletAuth();
  const [state, setState] = useState<ThumbnailState>(IDLE);

  useEffect(() => {
    if (!file) {
      setState(IDLE);
      return;
    }

    const plan = planThumbnail(file, polkadotAddress);
    if (plan.kind === "none") {
      setState(IDLE);
      return;
    }
    // EVERY branch defers until the cell is in view — cloud downloads, HEIC
    // conversions, and local resolutions alike (see the local branch below).
    if (!enabled) {
      setState(IDLE);
      return;
    }

    const previewFileName = file.actualFileName || file.name;
    if (isHeicFileName(previewFileName)) {
      // A CLOUD HEIC downloads + decrypts the full file (cache_remote_file),
      // so it takes a cloud slot. A LOCAL HEIC skips the network but still
      // runs a full wasm conversion in the WebView — iPhone camera rolls are
      // HEIC-dominant, so an unpooled in-view burst reproduces the very
      // spike the pools exist to prevent.
      return runThumbnailJob({
        pool: plan.kind === "cloud" ? cloudThumbnailPool : localThumbnailPool,
        job: () => prepareHeicThumbnail(file, plan, maxDim),
        describe: "HEIC thumbnail",
        revokeOnDrop: true,
        setState,
      });
    }

    if (plan.kind === "local") {
      const request = rustThumbnailRequest(file, polkadotAddress);
      // Formats a JPEG thumbnail would degrade, and rows without the server
      // ids the Rust cache is keyed on, serve the original url — bounded by
      // the in-view gate above. Serving an on-disk path is free; it was the
      // ungated full-resolution <img> per mounted cell that let a 13k-photo
      // folder kick off ~30 GB of asset-protocol fetches on viewer open and
      // freeze the WebView (support ticket 142).
      if (!request) {
        setState({ url: plan.url, isLoading: false, error: null });
        return;
      }
      const cacheKey = resolvedUrlKey(request.arionHash, request.fileId, maxDim);
      const cached = resolvedUrlCache.get(cacheKey);
      if (cached) {
        setState({ url: cached, isLoading: false, error: null });
        return;
      }
      // Known edge, accepted: a local-planned row whose on-disk copy vanished
      // outside the app falls through to Rust's cloud download under THIS
      // pool rather than the cloud one — bounded at the pool width.
      return runThumbnailJob({
        pool: localThumbnailPool,
        job: async () => {
          const url = await fetchRustThumbnail(request, maxDim);
          cacheResolvedUrl(cacheKey, url);
          return url;
        },
        describe: "local thumbnail",
        fallbackUrl: plan.url,
        setState,
      });
    }

    // Cloud: downloads + decrypts the FULL file — on a remote camera roll
    // every visible row is a multi-MB photo, and an ungated burst of 30-50
    // of them saturated the network/CPU (page jank, and it starved the
    // listing's own page fetches). Rows that scroll out of view while still
    // queued are cancelled before their download ever starts.
    const cloudCacheKey = resolvedUrlKey(plan.arionHash, plan.fileId, maxDim);
    const cachedCloud = resolvedUrlCache.get(cloudCacheKey);
    if (cachedCloud) {
      setState({ url: cachedCloud, isLoading: false, error: null });
      return;
    }
    return runThumbnailJob({
      pool: cloudThumbnailPool,
      job: async () => {
        const url = await fetchRustThumbnail(
          {
            accountId: plan.accountId,
            label: plan.label,
            fileId: plan.fileId,
            arionHash: plan.arionHash,
            source: plan.source,
          },
          maxDim,
        );
        cacheResolvedUrl(cloudCacheKey, url);
        return url;
      },
      describe: "thumbnail",
      setState,
    });
    // Re-resolve only on identity/account/visibility changes — not on unrelated
    // object-reference churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    maxDim,
    file?.fileId,
    file?.arionHash,
    file?.name,
    file?.actualFileName,
    file?.source,
    file?.label,
    file?.syncStatus,
    polkadotAddress,
  ]);

  return state;
}

export default useThumbnail;
