"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";
import { Download, FileIcon, FileText, Film, Music, Play } from "lucide-react";
import { MsgType } from "matrix-js-sdk";
import { toast } from "sonner";

import { autoplayGifsAtom } from "@/components/chat/chat-ui-atoms";
import { useAttachmentUrl } from "@/components/chat/hooks/useAttachmentUrl";
import Lightbox from "@/components/chat/Lightbox";
import { saveAttachmentToDisk, saveErrorMessage } from "@/components/chat/saveAttachment";
import { formatFileSize } from "@/lib/chat/attachments";
import type { Attachment } from "@/lib/chat/timeline";

interface AttachmentViewProps {
  client: MatrixClient;
  attachment: Attachment;
  senderName: string;
}

const MAX_W = 360;
const MAX_H = 280;

export function fitBox(w: number | null, h: number | null): { width: number; height: number } {
  if (!w || !h) return { width: 240, height: 180 };
  const scale = Math.min(MAX_W / w, MAX_H / h, 1);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function fileGlyph(mimetype: string | null) {
  if (!mimetype) return FileIcon;
  if (mimetype.startsWith("video/")) return Film;
  if (mimetype.startsWith("audio/")) return Music;
  if (mimetype.startsWith("text/") || mimetype.includes("pdf") || mimetype.includes("document")) return FileText;
  return FileIcon;
}

/** Image preview, video poster, audio player or file card, per msgtype. */
export default function AttachmentView({ client, attachment, senderName }: AttachmentViewProps) {
  if (attachment.gif) return <GifAttachment client={client} attachment={attachment} senderName={senderName} />;
  if (attachment.msgtype === MsgType.Image) return <ImageAttachment client={client} attachment={attachment} senderName={senderName} />;
  if (attachment.msgtype === MsgType.Video) return <VideoAttachment client={client} attachment={attachment} senderName={senderName} />;
  if (attachment.msgtype === MsgType.Audio) return <AudioAttachment client={client} attachment={attachment} />;
  return <FileAttachment client={client} attachment={attachment} />;
}

function ImageAttachment({ client, attachment, senderName }: AttachmentViewProps) {
  const box = fitBox(attachment.width, attachment.height);
  const thumb = useAttachmentUrl(client, attachment, "thumbnail", { width: box.width * 2, height: box.height * 2, method: "scale" });
  const [open, setOpen] = useState(false);
  const full = useAttachmentUrl(client, attachment, "full", undefined, open);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open image ${attachment.name}`}
        style={{ width: box.width, height: box.height }}
        className="mt-1 block overflow-hidden rounded-lg border border-grey-80 bg-grey-90 text-left dark:border-black-500 dark:bg-black-500"
      >
        {thumb.status === "ready" ? (
          <img src={thumb.url} alt={attachment.name} width={box.width} height={box.height} className="size-full object-cover" />
        ) : thumb.status === "error" ? (
          <span className="flex size-full items-center justify-center text-xs text-grey-60 dark:text-grey-dark-700">Could not load image</span>
        ) : (
          <span className="block size-full animate-pulse" />
        )}
      </button>
      <Lightbox
        open={open}
        onClose={() => setOpen(false)}
        url={full.status === "ready" ? full.url : null}
        name={attachment.name}
        size={attachment.size}
        senderName={senderName}
        kind="image"
      />
    </>
  );
}

/** Corner label so an animated image reads as a GIF even while still. */
export function GifBadge() {
  return (
    <span
      className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black-900/70 px-1 py-0.5 text-[10px] font-bold leading-none text-white dark:bg-black-900/70 dark:text-white"
      aria-hidden
    >
      GIF
    </span>
  );
}

/**
 * First frame of an animated image, drawn once onto a canvas so nothing
 * moves. Used when "Autoplay GIFs" is off and the sender attached no still
 * thumbnail (other clients do not).
 */
function StillFrame({ src, width, height, alt }: { src: string; width: number; height: number; alt: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = width;
      canvas.height = height;
      // object-fit: cover
      const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, width, height]);
  return <canvas ref={canvasRef} width={width} height={height} role="img" aria-label={alt} className="size-full" />;
}

/**
 * Animated GIF (or the silent MP4 standing in for one). Plays inline at the
 * image cap when "Autoplay GIFs" is on; otherwise shows a still frame and
 * plays while hovered or after a click. Click while playing opens the
 * lightbox. Everything comes from the homeserver, decrypted here.
 */
export function GifAttachment({ client, attachment, senderName }: AttachmentViewProps) {
  const autoplay = useAtomValue(autoplayGifsAtom);
  const box = fitBox(attachment.width, attachment.height);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [open, setOpen] = useState(false);
  const playing = autoplay || hovered || pinned;
  const isVideo = attachment.msgtype === MsgType.Video;

  // Reset the manual state when the preference flips.
  useEffect(() => setPinned(false), [autoplay]);

  // A still to show while not playing: the sender's thumbnail, or a server
  // thumbnail for a plain (unencrypted) file. An encrypted GIF without one
  // gets its first frame drawn from the decrypted full file instead; an
  // encrypted video without one shows a play glyph.
  const hasStillSource = Boolean(attachment.thumbnailFile ?? attachment.thumbnailUrl) || !attachment.file;
  const still = useAttachmentUrl(client, attachment, "thumbnail", { width: box.width * 2, height: box.height * 2, method: "scale" }, hasStillSource);
  const needsFullForStill = !hasStillSource && !isVideo;
  const full = useAttachmentUrl(client, attachment, "full", undefined, playing || open || needsFullForStill);

  const onClick = () => {
    if (autoplay || pinned) setOpen(true);
    else setPinned(true);
  };

  const failed = full.status === "error" || (hasStillSource && still.status === "error");
  const stillFrame = failed ? (
    <span className="flex size-full items-center justify-center text-xs text-grey-60 dark:text-grey-dark-700">Could not load GIF</span>
  ) : hasStillSource && still.status === "ready" ? (
    <img src={still.url} alt={attachment.name} width={box.width} height={box.height} className="size-full object-cover" />
  ) : needsFullForStill && full.status === "ready" ? (
    <StillFrame src={full.url} width={box.width} height={box.height} alt={attachment.name} />
  ) : isVideo && !hasStillSource ? (
    <span className="flex size-full items-center justify-center text-grey-60 dark:text-grey-dark-700">
      <Play className="size-8" aria-hidden />
    </span>
  ) : (
    <span className="block size-full animate-pulse" />
  );

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={playing ? `Open GIF ${attachment.name}` : `Play GIF ${attachment.name}`}
        data-playing={playing ? "true" : "false"}
        style={{ width: box.width, height: box.height }}
        className="relative mt-1 block overflow-hidden rounded-lg border border-grey-80 bg-grey-90 text-left dark:border-black-500 dark:bg-black-500"
      >
        {playing && full.status === "ready" ? (
          isVideo ? (
            <video src={full.url} autoPlay muted loop playsInline disablePictureInPicture aria-label={attachment.name} className="size-full object-cover" />
          ) : (
            <img src={full.url} alt={attachment.name} width={box.width} height={box.height} className="size-full object-cover" />
          )
        ) : (
          stillFrame
        )}
        <GifBadge />
      </button>
      <Lightbox
        open={open}
        onClose={() => setOpen(false)}
        url={full.status === "ready" ? full.url : null}
        name={attachment.name}
        size={attachment.size}
        senderName={senderName}
        kind={isVideo ? "video" : "image"}
      />
    </>
  );
}

function VideoAttachment({ client, attachment, senderName }: AttachmentViewProps) {
  const box = fitBox(attachment.width, attachment.height);
  const poster = useAttachmentUrl(client, attachment, "thumbnail", { width: box.width * 2, height: box.height * 2, method: "scale" });
  const [open, setOpen] = useState(false);
  const full = useAttachmentUrl(client, attachment, "full", undefined, open);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Play video ${attachment.name}`}
        style={{ width: box.width, height: box.height }}
        className="relative mt-1 block overflow-hidden rounded-lg border border-grey-80 bg-black-900 dark:border-black-500 dark:bg-black-900"
      >
        {poster.status === "ready" ? (
          <img src={poster.url} alt="" className="size-full object-cover opacity-80" />
        ) : null}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="inline-flex size-12 items-center justify-center rounded-full bg-white/90 text-grey-10 dark:bg-white/90 dark:text-grey-10">
            <Play className="ml-0.5 size-6" aria-hidden />
          </span>
        </span>
      </button>
      <Lightbox
        open={open}
        onClose={() => setOpen(false)}
        url={full.status === "ready" ? full.url : null}
        name={attachment.name}
        size={attachment.size}
        senderName={senderName}
        kind="video"
      />
    </>
  );
}

function AudioAttachment({ client, attachment }: Omit<AttachmentViewProps, "senderName">) {
  const media = useAttachmentUrl(client, attachment, "full");
  return (
    <div className="mt-1 flex max-w-md flex-col gap-1 rounded-lg border border-grey-80 bg-grey-light-600 p-2 dark:border-black-500 dark:bg-black-primary-bg">
      <p className="truncate text-xs text-grey-10 dark:text-grey-light-100">{attachment.name}</p>
      {media.status === "ready" ? (
        <audio src={media.url} controls className="w-full" aria-label={attachment.name} />
      ) : (
        <div className="h-8 animate-pulse rounded bg-grey-90 dark:bg-black-500" />
      )}
    </div>
  );
}

function FileAttachment({ client, attachment }: Omit<AttachmentViewProps, "senderName">) {
  const [wanted, setWanted] = useState(false);
  const [saving, setSaving] = useState(false);
  const media = useAttachmentUrl(client, attachment, "full", undefined, wanted);
  const Glyph = fileGlyph(attachment.mimetype);
  const ready = media.status === "ready";
  const autoSaved = useRef(false);

  const saveToDisk = useCallback(
    async (url: string) => {
      setSaving(true);
      try {
        if ((await saveAttachmentToDisk(url, attachment.name)) === "saved") toast.success(`Saved ${attachment.name}`);
      } catch (error) {
        toast.error(saveErrorMessage(error));
      } finally {
        setSaving(false);
      }
    },
    [attachment.name],
  );

  // The user asked for the file before it was fetched (and decrypted): open
  // the save dialog as soon as the bytes exist, once.
  useEffect(() => {
    if (wanted && media.status === "ready" && !autoSaved.current) {
      autoSaved.current = true;
      void saveToDisk(media.url);
    }
  }, [wanted, media, saveToDisk]);

  const busy = media.status === "loading" || saving;
  const status = media.status === "loading" ? " · preparing…" : media.status === "error" ? " · download failed" : saving ? " · saving…" : "";

  return (
    <div className="mt-1 inline-flex max-w-md items-center gap-3 rounded-lg border border-grey-80 bg-grey-light-600 p-2 pr-3 dark:border-black-500 dark:bg-black-primary-bg">
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-primary-50/10 text-primary-50 dark:bg-primary-40/20 dark:text-primary-40">
        <Glyph className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-grey-10 dark:text-grey-light-100">{attachment.name}</p>
        <p className="text-xs text-grey-60 dark:text-grey-dark-700">
          {attachment.size !== null ? formatFileSize(attachment.size) : attachment.mimetype ?? "File"}
          {status}
        </p>
      </div>
      <button
        type="button"
        onClick={() => (ready ? void saveToDisk(media.url) : setWanted(true))}
        disabled={busy}
        aria-label={`Download ${attachment.name}`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-grey-60 hover:bg-grey-90 hover:text-grey-10 disabled:opacity-50 dark:text-grey-dark-700 dark:hover:bg-black-500 dark:hover:text-grey-light-100"
      >
        <Download className="size-4" aria-hidden />
      </button>
    </div>
  );
}
