"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  Check,
  FolderOpen,
  FolderSearch,
  Link2,
  MoreHorizontal,
  RotateCw,
  Sparkles,
  Trash2,
  Video,
  X,
} from "lucide-react";
import "@/app/lib/capture/floating-window.css";
import "./capture-preview.css";
import {
  copyCapturePreviewLink,
  discardCapturePreview,
  dismissCapturePreview,
  getCapturePreview,
  mintCapturePreviewLink,
  retryCapturePreview,
  revealCapturePreview,
  revokeCapturePreviewLink,
  showCapturePreviewInFolder,
  upgradeFromCapturePreview,
  type CapturePreviewCard,
} from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress, SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import { GLASS_BUTTON, GLASS_FOCUS, GLASS_MUTED, GLASS_PANEL, GLASS_PRIMARY } from "@/app/lib/capture/glass";
import { fileManagerLabel } from "@/app/lib/utils/isMacPlatform";
import { AUTO_HIDE_MS, cardView, destinationText, wantsProgress } from "./previewCard";

/** How long "Copied" shows before the button reads "Copy link" again. */
const COPIED_MS = 1500;

// Every label stays on one line (`whitespace-nowrap`): the card is 316 pt
// wide, and "Show in folder" once broke in two beside three other buttons.
// The row is one primary that takes the room left (`flex-1`, `min-w-0`), a
// compact secondary sized to its label (`shrink-0`) and at most one 32 pt
// icon button; the rest of the actions live in the More menu.
const ACTION = "flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] px-2.5 text-[12px]";
const PRIMARY_ACTION = `${ACTION} min-w-0 flex-1 ${GLASS_PRIMARY}`;
const SECONDARY_ACTION = `${ACTION} shrink-0 bg-white/10 font-medium ${GLASS_BUTTON}`;
const ICON_ACTION = `grid size-8 shrink-0 place-items-center rounded-[8px] bg-white/10 ${GLASS_BUTTON}`;
const MENU_ITEM = `flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-[7px] px-2.5 text-left text-[12px] ${GLASS_BUTTON}`;

/**
 * The card that slides into the corner after a capture, like the macOS
 * screenshot thumbnail: the picture, the upload as it happens, and one click
 * to the folder it went into. Opened by Rust without taking focus, and kept
 * out of any later capture.
 *
 * Dark glass whatever the app's theme, as the capture bar and macOS's own
 * thumbnail are: it floats over other apps.
 *
 * Rust decides the buttons (`card.actions`) and words the link
 * (`card.linkText`); the card only draws them. Actions are one row: one
 * primary (Show in folder), one compact secondary (Copy link / Create link)
 * and a "More" menu holding Show in Finder / Explorer and Revoke link, so no
 * label ever wraps. A failed card offers Upgrade / Retry / Discard the same
 * way, Discard becoming an icon when all three are there.
 *
 * Sized for Rust's 316 x 330 pt window in every state (16:9 picture, the
 * failure reason on one line with the whole of it in the tooltip): the card
 * sits at the window's bottom, so anything taller is cut off at the TOP,
 * close button first.
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const cardId = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  const clearCopied = useCallback(() => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = null;
    setCopied(false);
  }, []);

  useEffect(() => {
    let heard = false;
    void getCapturePreview()
      .then((c) => !heard && setCard(c))
      .catch(() => undefined);
    const unlisten = listen<CapturePreviewCard | null>("capture_preview_changed", (e) => {
      heard = true;
      setCard(e.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Progress only while there is an upload to follow: the card is prewarmed
  // hidden at every capture start, and the sync engine emits up to four
  // snapshots a second, hundreds of rows each.
  const following = wantsProgress(card) ? card : null;
  const followingId = following?.id ?? null;
  useEffect(() => {
    if (followingId === null) return;
    const unlisteners = [
      listen<RemoteUploadProgress>("remote_upload_progress", (e) => setRow(e.payload)),
      listen<SyncSnapshot>("sync_progress_snapshot", (e) => setSyncFiles(e.payload.files)),
    ];
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, [followingId]);

  // A new capture replaced this card: forget the old one's progress.
  useEffect(() => {
    if (card && card.id !== cardId.current) {
      cardId.current = card.id;
      setRow(null);
      setSyncFiles([]);
      setMenuOpen(false);
      clearCopied();
    }
  }, [card, clearCopied]);

  useEffect(() => clearCopied, [clearCopied]);

  const dismiss = useCallback(() => {
    if (card) void dismissCapturePreview(card.id).catch(() => undefined);
  }, [card]);

  // The menu takes the keyboard while open: focus on its first item, arrows
  // move between items, Escape closes it and gives focus back to More.
  useEffect(() => {
    if (!menuOpen) return;
    const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        menuButton.current?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const list = items();
      if (list.length === 0) return;
      e.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const view = card ? cardView(card, row, syncFiles) : null;
  const done = view?.done ?? false;
  const settled = view?.settled ?? false;

  // Once in the drive with its link settled, the card slides away on its own,
  // unless the pointer is on it. Not before the link: it would go before it
  // could say the link was copied.
  useEffect(() => {
    if (!settled || hovered) return;
    const t = window.setTimeout(dismiss, AUTO_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [settled, hovered, dismiss, timerRun]);

  if (!card || !view) return null;
  const { percent, failed } = view;
  const uploaded = done;
  const actions = card.actions;
  const failure = card.status.state === "failed" ? card.status.message : null;
  const fileManager = fileManagerLabel();

  /** One card action at a time; Rust reports what went wrong on the card itself. */
  const run = (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void action()
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const showInFolder = () => void showCapturePreviewInFolder().catch(() => undefined);

  const copy = () => {
    void copyCapturePreviewLink()
      .then(() => {
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        setCopied(true);
        copiedTimer.current = window.setTimeout(() => {
          copiedTimer.current = null;
          setCopied(false);
        }, COPIED_MS);
      })
      .catch(() => undefined);
  };

  return (
    <div className="flex h-full w-full items-end justify-end p-1.5">
      <div
        data-testid="capture-card"
        className={`capture-card-enter relative w-full overflow-hidden rounded-[14px] p-2 ${GLASS_PANEL}`}
        // Mouse events too: a window that is not key may get no pointer events
        // on some WebViews, and the hold must work there as well.
        onPointerEnter={() => setHovered(true)}
        onMouseEnter={() => setHovered(true)}
        onPointerLeave={() => {
          setHovered(false);
          setTimerRun((n) => n + 1);
        }}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="mb-1.5 flex h-7 items-center gap-2 pl-0.5">
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={card.fileName}>
            {card.fileName}
          </p>
          <button
            type="button"
            aria-label="Close"
            onClick={dismiss}
            className={`grid size-7 shrink-0 place-items-center rounded-full ${GLASS_BUTTON}`}
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <button
          type="button"
          onClick={failed ? undefined : showInFolder}
          aria-label={`Show ${card.fileName} in its folder`}
          title="Show in folder"
          className={`group relative block aspect-[16/9] w-full overflow-hidden rounded-[9px] bg-white/5 ${GLASS_FOCUS}`}
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
            <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-[#000]/60 px-2 py-0.5 text-[11px] font-medium">
              <Video className="size-3" /> Recording
            </span>
          )}
          {!failed && (
            <span className="pointer-events-none absolute inset-0 grid place-items-center bg-[#000]/0 opacity-0 transition duration-150 group-hover:bg-[#000]/35 group-hover:opacity-100 motion-reduce:transition-none">
              <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#000]/70 px-3 py-1 text-[12px] font-medium">
                <FolderOpen className="size-3.5" /> Show in folder
              </span>
            </span>
          )}
        </button>

        <div className="mt-2 flex flex-col gap-1 px-0.5">
          {/* Only the status line is live: wrapping the card re-announced
              every button whenever anything on it changed. */}
          <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-[12px] leading-[18px] text-white/75">
            {uploaded && <Check aria-hidden className="size-3.5 shrink-0 text-[#30D158]" />}
            {failed && <AlertCircle aria-hidden className="size-3.5 shrink-0 text-[#FF453A]" />}
            <span className="truncate">{view.text}</span>
          </p>
          <p className={`truncate text-[11.5px] leading-4 ${GLASS_MUTED}`} title={destinationText(card)}>
            {destinationText(card)}
          </p>
          {!uploaded && !failed && (
            <div
              className="h-1 overflow-hidden rounded-full bg-white/15"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              aria-label="Upload progress"
            >
              <div
                className={`h-full rounded-full bg-[#3167DD] transition-[width] duration-300 motion-reduce:transition-none ${
                  percent === null ? "w-1/4 animate-pulse motion-reduce:animate-none" : ""
                }`}
                style={percent === null ? undefined : { width: `${Math.max(4, percent)}%` }}
              />
            </div>
          )}
          {settled && (
            // Stays put while hovered, paused, so the card does not change
            // height under the pointer; leaving starts it over.
            <div className="h-0.5 overflow-hidden rounded-full bg-white/10" aria-hidden data-testid="auto-hide-timer">
              <div
                key={timerRun}
                className="capture-card-timer h-full bg-white/35"
                style={{ animationDuration: `${AUTO_HIDE_MS}ms`, animationPlayState: hovered ? "paused" : "running" }}
              />
            </div>
          )}
          {failure && (
            <p className={`line-clamp-1 text-[11.5px] leading-4 ${GLASS_MUTED}`} title={failure}>
              {failure}
            </p>
          )}
        </div>

        <div className="relative mt-2 flex gap-1.5" data-testid="capture-actions">
          {failed ? (
            <>
              {actions.upgrade && (
                <button type="button" onClick={() => run(upgradeFromCapturePreview)} className={PRIMARY_ACTION}>
                  <Sparkles aria-hidden className="size-3.5 shrink-0" /> Upgrade
                </button>
              )}
              {actions.retry && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(retryCapturePreview)}
                  className={actions.upgrade ? SECONDARY_ACTION : PRIMARY_ACTION}
                >
                  <RotateCw aria-hidden className="size-3.5 shrink-0" /> Retry
                </button>
              )}
              {actions.discard &&
                (actions.upgrade && actions.retry ? (
                  // Three text buttons do not fit on one line: Discard becomes an icon.
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Discard"
                    title="Discard"
                    onClick={() => run(discardCapturePreview)}
                    className={ICON_ACTION}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => run(discardCapturePreview)} className={SECONDARY_ACTION}>
                    <Trash2 aria-hidden className="size-3.5 shrink-0" /> Discard
                  </button>
                ))}
              {!actions.retry && !actions.upgrade && (
                // The sync queue retries a synced capture on its own.
                <button type="button" onClick={showInFolder} className={PRIMARY_ACTION}>
                  <FolderOpen aria-hidden className="size-3.5 shrink-0" /> Show in folder
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" onClick={showInFolder} className={PRIMARY_ACTION}>
                <FolderOpen aria-hidden className="size-3.5 shrink-0" /> Show in folder
              </button>
              {actions.mintLink ? (
                <button type="button" disabled={busy} onClick={() => run(mintCapturePreviewLink)} className={SECONDARY_ACTION}>
                  <Link2 aria-hidden className="size-3.5 shrink-0" /> Create link
                </button>
              ) : (
                <button type="button" disabled={!actions.copyLink} onClick={copy} className={SECONDARY_ACTION}>
                  {copied ? <Check aria-hidden className="size-3.5 shrink-0" /> : <Link2 aria-hidden className="size-3.5 shrink-0" />}
                  {copied ? "Copied" : "Copy link"}
                </button>
              )}
              {(actions.reveal || actions.revokeLink) && (
                <button
                  ref={menuButton}
                  type="button"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  title="More"
                  onClick={() => setMenuOpen((open) => !open)}
                  className={ICON_ACTION}
                >
                  <MoreHorizontal aria-hidden className="size-4" />
                </button>
              )}
              {menuOpen && (actions.reveal || actions.revokeLink) && (
                // Opens upward over the picture: the card sits at the window's
                // bottom edge, so there is no room below.
                <div
                  ref={menu}
                  role="menu"
                  aria-label="More"
                  className={`absolute bottom-10 right-0 z-10 min-w-[170px] rounded-[10px] p-1 ${GLASS_PANEL}`}
                >
                  {actions.reveal && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        run(revealCapturePreview);
                      }}
                      className={MENU_ITEM}
                    >
                      <FolderSearch aria-hidden className="size-3.5 shrink-0" /> Show in {fileManager}
                    </button>
                  )}
                  {actions.revokeLink && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        run(revokeCapturePreviewLink);
                      }}
                      className={MENU_ITEM}
                    >
                      <X aria-hidden className="size-3.5 shrink-0" /> Revoke link
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
