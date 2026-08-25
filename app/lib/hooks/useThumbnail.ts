import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

/**
 * What it takes to render a thumbnail for one file, resolved from its identity.
 *
 *  - `local`  — the plaintext file is already on disk; serve it straight via the
 *    asset protocol (no network, instant). Same fast path the card view always
 *    used, so synced files are never slowed down or rerouted.
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
 * `enabled` gates cloud fetches and local HEIC conversion so a grid doesn't
 * download or decode every item at once. Ordinary local images still resolve
 * immediately because serving an on-disk path is free.
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
    const previewFileName = file.actualFileName || file.name;
    if (isHeicFileName(previewFileName)) {
      if (plan.kind === "none" || !enabled) {
        setState(IDLE);
        return;
      }

      let cancelled = false;
      let thumbnailUrl = "";
      setState({ url: null, isLoading: true, error: null });
      void prepareHeicThumbnail(file, plan, maxDim)
        .then((url) => {
          thumbnailUrl = url;
          if (cancelled) {
            URL.revokeObjectURL(url);
            thumbnailUrl = "";
            return;
          }
          setState({ url, isLoading: false, error: null });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error
              ? error.message
              : "Failed to prepare HEIC thumbnail.";
          setState({ url: null, isLoading: false, error: message });
        });

      return () => {
        cancelled = true;
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      };
    }

    if (plan.kind === "local") {
      setState({ url: plan.url, isLoading: false, error: null });
      return;
    }
    if (plan.kind === "none") {
      setState(IDLE);
      return;
    }

    // Cloud: defer the download until the item is in view.
    if (!enabled) {
      setState(IDLE);
      return;
    }

    let cancelled = false;
    setState({ url: null, isLoading: true, error: null });
    invoke<string>("get_thumbnail", {
      accountId: plan.accountId,
      label: plan.label,
      fileId: plan.fileId,
      arionHash: plan.arionHash,
      source: plan.source,
      maxDim,
    })
      .then((path) => {
        if (cancelled) return;
        setState({
          url: convertFileSrc(path.replace(/\\/g, "/")),
          isLoading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          typeof err === "string"
            ? err
            : ((err as { message?: string })?.message ?? "Failed to load thumbnail.");
        setState({ url: null, isLoading: false, error: message });
      });

    return () => {
      cancelled = true;
    };
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
