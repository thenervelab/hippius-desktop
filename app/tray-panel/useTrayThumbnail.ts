import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import { previewCacheContentHash } from "@/app/lib/utils/arionContentHash";

/** Mirrors Rust's `tray::thumbnail::TrayThumbnail`. */
export interface TrayThumbnail {
  path: string;
  kind: "image" | "video";
  durationSecs: number | null;
}

/** What a row draws: the picture's URL, and a recording's length. */
export interface TrayRowPicture {
  url: string;
  kind: "image" | "video";
  durationSecs: number | null;
}

/**
 * Pictures already resolved this session, by file. `null` is "Rust says
 * this file has no picture" and is kept too, so a PDF is asked about once.
 * A failure is not kept: a cloud file that could not be fetched is asked
 * for again the next time its row mounts.
 */
const resolved = new Map<string, TrayRowPicture | null>();

/** A cloud file is downloaded whole for its picture; keep a few at a time. */
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
}

function release(): void {
  inFlight -= 1;
  waiting.shift()?.();
}

/** The cache key: the drive and the file's content (or path) id. */
export function trayThumbnailKey(item: UploadFeedItem): string | null {
  const id = previewCacheContentHash(item) || item.fileId || item.arionHash;
  if (!id || !item.label) return null;
  return `${item.label}::${id}`;
}

/** Forget a picture whose file has gone (an `<img>` error), so it is asked for again. */
export function forgetTrayThumbnail(item: UploadFeedItem): void {
  const key = trayThumbnailKey(item);
  if (key) resolved.delete(key);
}

/** Test seam: start each test with nothing resolved. */
export function resetTrayThumbnails(): void {
  resolved.clear();
}

/**
 * A row's picture, from Rust's `get_tray_thumbnail`: the cached JPEG of a
 * screenshot or of a recording's frame, or null while it is being made and
 * when the file has none (the row keeps its file-type icon). Which files get
 * one is Rust's decision; only finished uploads are asked about, since a file
 * on its way has no server copy to picture yet.
 */
export function useTrayThumbnail(
  item: UploadFeedItem,
  accountId: string | null,
): TrayRowPicture | null {
  const key = item.feedStatus === "completed" && accountId ? trayThumbnailKey(item) : null;
  const [picture, setPicture] = useState<TrayRowPicture | null>(() =>
    key ? (resolved.get(key) ?? null) : null,
  );

  useEffect(() => {
    if (!key || !accountId) {
      setPicture(null);
      return;
    }
    if (resolved.has(key)) {
      setPicture(resolved.get(key) ?? null);
      return;
    }
    let live = true;
    void (async () => {
      await acquire();
      try {
        if (!live) return;
        const answer = await invoke<TrayThumbnail | null>("get_tray_thumbnail", {
          accountId,
          label: item.label ?? "",
          fileId: item.fileId || item.arionHash || "",
          arionHash: previewCacheContentHash(item),
          source: item.source || null,
          fileName: item.actualFileName || item.name,
          size: typeof item.size === "number" ? item.size : null,
        });
        const next =
          answer && typeof answer.path === "string" && answer.path.length > 0
          ? {
              url: convertFileSrc(answer.path.replace(/\\/g, "/")),
              kind: answer.kind,
              durationSecs: answer.durationSecs ?? null,
            }
          : null;
        resolved.set(key, next);
        if (live) setPicture(next);
      } catch (error) {
        console.warn("[TrayPanel] No picture for a row:", error);
        if (live) setPicture(null);
      } finally {
        release();
      }
    })();
    return () => {
      live = false;
    };
    // The key names the file; the rest of the item is what the request reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accountId]);

  return picture;
}
