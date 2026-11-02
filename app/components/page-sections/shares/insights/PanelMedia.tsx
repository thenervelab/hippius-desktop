"use client";

import { useEffect, useState } from "react";
import { atom, useAtom } from "jotai";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { File as FileIcon, ImageIcon, Maximize2, Video } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useThumbnail } from "@/app/lib/hooks/useThumbnail";
import { getFileUrl } from "@/app/lib/utils/fileUrlResolver";
import { openInDefaultApp } from "@/components/page-sections/drive/file-preview/previewBytes";
import { useVideoPlayback } from "@/components/page-sections/drive/file-preview/videoPlayback";
import {
  HIDE_PREVIEW,
  OPEN_CAPTURE,
  SHOW_PREVIEW,
  captureMediaKind,
  planPanelMedia,
  type CaptureMediaKind,
  type DriveLocation,
  type MediaPlan,
} from "./panelLinkMedia";
import { FOCUS, SKELETON } from "./panelStyles";

/** Big enough for the panel's preview on a Retina screen, small enough to stay a thumbnail. */
export const PREVIEW_THUMB_MAX_DIM = 640;

/**
 * Whether the preview under the header is open. Kept for the session, in
 * memory only, so somebody who closed it to make room does not have to close
 * it again on every link.
 */
export const insightsPreviewOpenAtom = atom(true);

/**
 * A picture of the capture for the panel. `ready` carries the URL to draw
 * (for a recording, the one it plays from: Rust's loopback stream on Linux,
 * where the WebView cannot play `asset://` media) and the file on disk for
 * "Open", when there is one. `previewable` is false when the app is locked:
 * the header keeps its small frame, as before, and shows no preview.
 */
export type PanelMediaState =
  | { status: "none" }
  | { status: "loading"; kind: CaptureMediaKind; previewable: boolean }
  | { status: "ready"; kind: CaptureMediaKind; url: string; localPath: string | null; previewable: boolean };

/**
 * Finds the capture's picture through the paths the app already has (see
 * `planPanelMedia`): the file on disk, Rust's drive lookup, or the Files
 * grid's thumbnailer. No object URLs are made here; the thumbnailer owns the
 * ones it makes. `source` must be rendered: it runs the thumbnailer only
 * when a screenshot is on the server alone.
 */
export function usePanelMedia({
  file,
  fileName,
  location,
  unlocked,
}: {
  file?: FormattedUserFile;
  fileName: string;
  location: DriveLocation | null;
  unlocked: boolean;
}): { media: PanelMediaState; source: React.ReactNode } {
  const kind = captureMediaKind(fileName);
  const local = file ? getFileUrl(file) : null;
  const pendingCloud = file?.syncStatus === "pending" && !!file.fileId;
  const onDisk = Boolean(local?.isLocal && local.url && !pendingCloud);
  const plan: MediaPlan = planPanelMedia({ mediaKind: kind, file, onDisk, location, unlocked });

  const resolved = useQuery({
    queryKey: ["insights-panel-media", plan.kind === "resolve" ? plan.location : null],
    queryFn: () =>
      plan.kind === "resolve"
        ? invoke<string | null>("resolve_drive_file_source", {
            label: plan.location.label,
            relativePath: plan.location.relativePath,
          })
        : Promise.resolve(null),
    enabled: plan.kind === "resolve",
    retry: false,
    staleTime: 60_000,
  });

  // The thumbnailer's answer: undefined while it works, null when it can't.
  const [cloud, setCloud] = useState<string | null | undefined>(undefined);
  const cloudFile = plan.kind === "cloudThumb" ? file : undefined;

  let localPath: string | null = null;
  let url: string | null = null;
  let pending = false;
  if (plan.kind === "disk" && file?.source) {
    localPath = file.source.replace(/\\/g, "/");
    url = local!.url;
  } else if (plan.kind === "resolve") {
    pending = resolved.isPending;
    const path = resolved.data ? resolved.data.replace(/\\/g, "/") : null;
    if (path) {
      localPath = path;
      url = convertFileSrc(path);
    }
  } else if (plan.kind === "cloudThumb") {
    pending = cloud === undefined;
    url = cloud ?? null;
  }

  // A recording plays from where Rust says (`video_playback_source`); no
  // decoder, or no answer, and the panel shows the tile instead.
  const { playback, failed } = useVideoPlayback(kind === "video" && localPath ? localPath : "");
  if (kind === "video" && url) {
    if (failed) url = null;
    else if (!playback) pending = true;
    else if (playback.kind === "stream") url = playback.url;
    else if (playback.kind !== "webview") url = null;
  }

  const previewable = unlocked;
  let media: PanelMediaState = { status: "none" };
  if (kind && pending) media = { status: "loading", kind, previewable };
  else if (kind && url) media = { status: "ready", kind, url, localPath, previewable };

  return {
    media,
    source: cloudFile ? <CloudThumbnail key={cloudFile.fileId} file={cloudFile} onUrl={setCloud} /> : null,
  };
}

/** Runs the Files grid's thumbnailer for a screenshot that is only on the server. */
function CloudThumbnail({ file, onUrl }: { file: FormattedUserFile; onUrl: (url: string | null | undefined) => void }) {
  const thumb = useThumbnail(file, { maxDim: PREVIEW_THUMB_MAX_DIM });
  const settled = !thumb.isLoading && (thumb.url !== null || thumb.error !== null);
  useEffect(() => {
    onUrl(settled ? thumb.url : undefined);
  }, [settled, thumb.url, onUrl]);
  return null;
}

const TILE = "relative flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[8px]";

/**
 * The header's tile: a frame of the capture when there is one (a recording
 * also gives the panel its length), otherwise the file's kind. With a preview
 * to show it is the button that opens and closes it.
 */
export function MediaTile({
  media,
  fileName,
  previewId,
  onDuration,
}: {
  media: PanelMediaState;
  fileName: string;
  previewId: string;
  onDuration: (ms: number) => void;
}) {
  const [open, setOpen] = useAtom(insightsPreviewOpenAtom);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const ready = media.status === "ready" && media.url !== failedUrl ? media : null;
  const kind = captureMediaKind(fileName);
  const Icon = kind === "video" ? Video : kind === "image" ? ImageIcon : FileIcon;

  if (media.status === "loading") {
    return <span aria-hidden data-testid="insights-media-tile-loading" className={cn(TILE, SKELETON, "rounded-[8px]")} />;
  }

  const inner = ready ? (
    ready.kind === "video" ? (
      <video
        src={`${ready.url}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none size-full object-cover"
        onLoadedMetadata={(e) => {
          const seconds = e.currentTarget.duration;
          if (Number.isFinite(seconds) && seconds > 0) onDuration(Math.round(seconds * 1000));
        }}
        onError={() => setFailedUrl(ready.url)}
      />
    ) : (
      <img src={ready.url} alt="" className="size-full object-cover" onError={() => setFailedUrl(ready.url)} />
    )
  ) : (
    <Icon className="size-[18px]" />
  );
  const tone = ready ? "bg-[#000]" : "bg-primary-50/10 text-primary-50 dark:bg-primary-50/15 dark:text-primary-brand-dark";

  if (ready?.previewable) {
    return (
      <button
        type="button"
        aria-label={open ? HIDE_PREVIEW : SHOW_PREVIEW}
        aria-expanded={open}
        aria-controls={open ? previewId : undefined}
        title={open ? HIDE_PREVIEW : SHOW_PREVIEW}
        onClick={() => setOpen((v) => !v)}
        className={cn(TILE, tone, FOCUS, "transition-opacity hover:opacity-90")}
        data-testid="insights-media-tile"
      >
        {inner}
      </button>
    );
  }
  return (
    <span aria-hidden className={cn(TILE, tone)} data-testid="insights-media-tile">
      {inner}
    </span>
  );
}

/**
 * The capture under the header, while unlocked: the screenshot, or the
 * recording muted with its controls, and "Open" to see it full size in the
 * computer's own viewer. A skeleton of the same size while it loads; if it
 * can't be drawn it goes quietly and the tile stays.
 */
export function MediaPreview({ media, fileName, id }: { media: PanelMediaState; fileName: string; id: string }) {
  const [open] = useAtom(insightsPreviewOpenAtom);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!open || media.status === "none" || !media.previewable) return null;
  if (media.status === "loading") {
    return <div aria-hidden data-testid="insights-preview-loading" className={cn(SKELETON, "mt-3 aspect-video w-full rounded-[10px]")} />;
  }
  if (media.url === failedUrl) return null;
  const { localPath } = media;
  return (
    <figure id={id} data-testid="insights-preview" className="relative mt-3 overflow-hidden rounded-[10px] bg-[#000]">
      {media.kind === "video" ? (
        <video
          src={media.url}
          controls
          muted
          playsInline
          preload="metadata"
          aria-label={`Preview of ${fileName}`}
          className="aspect-video w-full object-contain"
          onError={() => setFailedUrl(media.url)}
        />
      ) : (
        <img
          src={media.url}
          alt={`Preview of ${fileName}`}
          className="aspect-video w-full object-contain"
          onError={() => setFailedUrl(media.url)}
        />
      )}
      {localPath && (
        <button
          type="button"
          aria-label={OPEN_CAPTURE}
          title={OPEN_CAPTURE}
          onClick={() => void openInDefaultApp(localPath).catch(() => toast.error("Couldn't open the file."))}
          className={cn(
            "absolute right-2 top-2 flex size-7 items-center justify-center rounded-md bg-[#000]/60 text-white transition-colors hover:bg-[#000]/80",
            FOCUS,
          )}
        >
          <Maximize2 className="size-3.5" aria-hidden />
        </button>
      )}
    </figure>
  );
}
