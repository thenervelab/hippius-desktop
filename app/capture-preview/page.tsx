"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Check, FolderOpen, Link2, RotateCw, Video, X } from "lucide-react";
import "./capture-preview.css";
import {
  copyCapturePreviewLink,
  dismissCapturePreview,
  getCapturePreview,
  retryCapturePreview,
  showCapturePreviewInFolder,
  type CapturePreviewCard,
} from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress, SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import { AUTO_HIDE_MS, canRetry, cardView, destinationText } from "./previewCard";

/**
 * The card that slides into the corner after a capture, like the macOS
 * screenshot thumbnail: the picture, the upload as it happens, and one click
 * to the folder it went into. Opened by Rust without taking focus, and kept
 * out of any later capture.
 *
 * Dark glass whatever the app's theme, as the capture bar and macOS's own
 * thumbnail are: it floats over other apps.
 */
export default function CapturePreviewPage() {
  const [card, setCard] = useState<CapturePreviewCard | null>(null);
  const [row, setRow] = useState<RemoteUploadProgress | null>(null);
  // The sync engine's rows, for a capture saved into a synced drive.
  const [syncFiles, setSyncFiles] = useState<FileProgress[]>([]);
  const [copied, setCopied] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Bumped each time the pointer leaves, so the timer bar starts over.
  const [timerRun, setTimerRun] = useState(0);
  const cardId = useRef<number | null>(null);

  useEffect(() => {
    void getCapturePreview().then(setCard).catch(() => undefined);
    const unlisteners = [
      listen<CapturePreviewCard | null>("capture_preview_changed", (e) => setCard(e.payload)),
      listen<RemoteUploadProgress>("remote_upload_progress", (e) => setRow(e.payload)),
      listen<SyncSnapshot>("sync_progress_snapshot", (e) => setSyncFiles(e.payload.files)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, []);

  // A new capture replaced this card: forget the old one's progress.
  useEffect(() => {
    if (card && card.id !== cardId.current) {
      cardId.current = card.id;
      setRow(null);
      setCopied(false);
    }
  }, [card]);

  const dismiss = useCallback(() => {
    if (card) void dismissCapturePreview(card.id).catch(() => undefined);
  }, [card]);

  const view = card ? cardView(card, row, syncFiles) : null;
  const done = view?.done ?? false;

  // Once in the drive, the card slides away on its own, unless the pointer is on it.
  useEffect(() => {
    if (!done || hovered) return;
    const t = window.setTimeout(dismiss, AUTO_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [done, hovered, dismiss, timerRun]);

  if (!card || !view) return null;
  const { percent, failed } = view;
  const uploaded = done;
  const canCopy = view.linkCopied;

  const showInFolder = () => void showCapturePreviewInFolder().catch(() => undefined);

  const copy = () => {
    void copyCapturePreviewLink()
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div className="flex h-full w-full items-end justify-end p-1.5">
      <div
        className="capture-card-enter relative w-full overflow-hidden rounded-[14px] border border-white/10 bg-[#1c1d21]/92 p-2.5 text-white shadow-[0_16px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl font-[system-ui,-apple-system,'Segoe_UI',sans-serif]"
        // Mouse events too: a window that is not key may get no pointer events
        // on some WebViews, and the hold must work there as well.
        onPointerEnter={() => setHovered(true)}
        onMouseEnter={() => setHovered(true)}
        onPointerLeave={() => {
          setHovered(false);
          setTimerRun((n) => n + 1);
        }}
        onMouseLeave={() => setHovered(false)}
        role="status"
        aria-live="polite"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={dismiss}
          className="absolute right-2 top-2 z-10 grid size-6 place-items-center rounded-full bg-black/55 text-white/80 hover:bg-black/75 hover:text-white"
        >
          <X className="size-3.5" />
        </button>

        <button
          type="button"
          onClick={canRetry(card) ? undefined : showInFolder}
          aria-label={`Show ${card.fileName} in its folder`}
          title="Show in folder"
          className="group relative block aspect-[16/10] w-full overflow-hidden rounded-[9px] bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-[#5B8BEF]"
        >
          {card.thumbnail ? (
            // A data: URL from Rust; next/image does not apply.
            <img src={card.thumbnail} alt="" className="size-full object-cover" />
          ) : (
            <div className="grid size-full place-items-center text-white/40">
              <Video className="size-8" />
            </div>
          )}
          {card.kind === "recording" && (
            <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium">
              <Video className="size-3" /> Recording
            </span>
          )}
          {!canRetry(card) && (
            <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition duration-150 group-hover:bg-black/35 group-hover:opacity-100">
              <span className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1 text-[12px] font-medium">
                <FolderOpen className="size-3.5" /> Show in folder
              </span>
            </span>
          )}
        </button>

        <div className="mt-2.5 flex flex-col gap-1 px-0.5">
          <p className="truncate text-[13px] font-semibold" title={card.fileName}>
            {card.fileName}
          </p>
          <p className="flex items-center gap-1.5 text-[12px] text-white/65">
            {uploaded && <Check className="size-3.5 text-[#30D158]" />}
            {failed && <AlertCircle className="size-3.5 text-[#FF453A]" />}
            <span className="truncate">
              {view.text} · {destinationText(card)}
            </span>
          </p>
          {!uploaded && !failed && (
            <div
              className="mt-1 h-1 overflow-hidden rounded-full bg-white/15"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              aria-label="Upload progress"
            >
              <div
                className={`h-full rounded-full bg-[#5B8BEF] transition-[width] duration-300 ${percent === null ? "w-1/4 animate-pulse" : ""}`}
                style={percent === null ? undefined : { width: `${Math.max(4, percent)}%` }}
              />
            </div>
          )}
          {done && !hovered && (
            <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-white/10" aria-hidden>
              <div
                key={timerRun}
                className="capture-card-timer h-full bg-white/35"
                style={{ animationDuration: `${AUTO_HIDE_MS}ms` }}
              />
            </div>
          )}
          {card.status.state === "failed" && (
            <p className="line-clamp-2 text-[12px] text-white/55">{card.status.message}</p>
          )}
        </div>

        <div className="mt-2.5 flex gap-1.5">
          {canRetry(card) ? (
            <button
              type="button"
              onClick={() => void retryCapturePreview().catch(() => undefined)}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[8px] bg-[#3167DD] text-[12px] font-semibold hover:bg-[#2a5bc6]"
            >
              <RotateCw className="size-3.5" /> Retry
            </button>
          ) : (
            <button
              type="button"
              onClick={showInFolder}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[8px] bg-[#3167DD] text-[12px] font-semibold hover:bg-[#2a5bc6]"
            >
              <FolderOpen className="size-3.5" /> Show in folder
            </button>
          )}
          <button
            type="button"
            disabled={!canCopy}
            onClick={copy}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[8px] bg-white/10 text-[12px] font-medium hover:bg-white/15 disabled:opacity-40"
          >
            {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}
