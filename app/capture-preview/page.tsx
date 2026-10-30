"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { onTauriEvent } from "@/app/lib/utils/tauriListeners";
import {
  AlertCircle,
  BarChart3,
  Check,
  FolderOpen,
  FolderPlus,
  Clock,
  FolderSearch,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCw,
  Settings2,
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
  editCapturePreview,
  getCapturePreview,
  getCapturePreviewPointer,
  manageCapturePreviewLink,
  mintCapturePreviewLink,
  openCapturePreviewInsights,
  retryCapturePreview,
  revealCapturePreview,
  revokeCapturePreviewLink,
  showCapturePreviewInFolder,
  upgradeFromCapturePreview,
  type CapturePreviewCard,
} from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import { getEngagementFeatures } from "@/app/lib/tauri/shareInsights";
import type { FileProgress, SyncSnapshot } from "@/app/lib/types/syncSnapshot";
import { GLASS_BUTTON, GLASS_FOCUS, GLASS_MUTED, GLASS_PANEL, GLASS_PRIMARY } from "@/app/lib/capture/glass";
import { fileManagerLabel } from "@/app/lib/utils/isMacPlatform";
import { markedAt } from "@/app/lib/capture/rustHover";
import { useBarTooltip } from "@/app/capture-overlay/BarTooltip";
import { AUTO_HIDE_MS, cardView, destinationText, wantsProgress } from "./previewCard";
import { barOffsetMs, nextCountdown, timeLeft, type Countdown } from "./autoHide";

/** How long "Copied" shows before the button reads "Copy link" again. */
const COPIED_MS = 1500;

/**
 * Focus the keyboard put there, the kind that draws the focus ring. A
 * button's focus after a click does not hold the card, or it would stay up
 * until the window lost focus. A WebView that cannot read the selector
 * holds on any focus, so the keyboard is never raced.
 */
function isKeyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

// Every label stays on one line (`whitespace-nowrap`): the card is 316 pt
// wide, and "Show in folder" once broke in two beside three other buttons.
// The row is one primary that takes the room left (`flex-1`, `min-w-0`), a
// compact secondary sized to its label (`shrink-0`) and at most one 32 pt
// icon button; the rest of the actions live in the More menu.
const ACTION = "flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] px-2.5 text-[12px]";
/** How often the card asks where the pointer is while it is up. */
const POINTER_POLL_MS = 100;
/**
 * Marks what has a tooltip (or, the picture, a hover face) on the card; the
 * value is its key. The card is never key, so its webview gets no hover on
 * macOS: the element under Rust's pointer is found by this mark instead.
 */
const CARD_TIP = "data-card-tip";
const PRIMARY_ACTION = `${ACTION} min-w-0 flex-1 ${GLASS_PRIMARY}`;
const SECONDARY_ACTION = `${ACTION} shrink-0 bg-white/10 font-medium ${GLASS_BUTTON}`;
const ICON_ACTION = `grid size-8 shrink-0 place-items-center rounded-[8px] bg-white/10 ${GLASS_BUTTON}`;
const MENU_ITEM = `flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-[7px] px-2.5 text-left text-[12px] ${GLASS_BUTTON}`;
/** The yes of a question that throws something away, red as the pill's. */
const DANGER_ACTION = `${ACTION} min-w-0 flex-1 bg-[#D70015] font-semibold text-white hover:bg-[#b80012] disabled:opacity-40 ${GLASS_FOCUS}`;

/** What the card asks before an action that cannot be undone. */
type CardQuestion = "discard" | "revoke";

const CARD_QUESTION: Record<CardQuestion, { text: string; keep: string; confirm: string }> = {
  // Discard is only offered on a capture that did not upload: its file
  // here is the only one.
  discard: {
    text: "Delete this capture? It didn't upload, so this is the only copy.",
    keep: "Keep",
    confirm: "Delete",
  },
  revoke: {
    text: "Turn off this link? Anyone who has it won't be able to open it.",
    keep: "Keep link",
    confirm: "Revoke",
  },
};

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
 * No native `title`: the card is never the key window, so macOS showed none
 * (and no `:hover`). The card asks Rust where the pointer is, lights what is
 * under it and names it in the capture bar's own tooltip, inside the window.
 *
 * Sized for Rust's 316 x 346 pt window in every state (16:9 picture, the
 * failure reason on one line with the whole of it in the tooltip, a notice on
 * two): the card sits at the window's bottom, so anything taller is cut off
 * at the TOP, close button first.
 */
export default function CapturePreviewPage() {
  const [card, setCard] = useState<CapturePreviewCard | null>(null);
  const [row, setRow] = useState<RemoteUploadProgress | null>(null);
  // The sync engine's rows, for a capture saved into a synced drive.
  const [syncFiles, setSyncFiles] = useState<FileProgress[]>([]);
  const [copied, setCopied] = useState(false);
  // Copy link failed (the clipboard refused): said on the card, and the
  // button offers to try again.
  const [copyFailed, setCopyFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Keyboard focus in the card holds it the way the pointer does.
  const [keyboardIn, setKeyboardIn] = useState(false);
  // The settled card's countdown before it slides away (`autoHide.ts`).
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Discard and Revoke link ask first, in the card itself.
  const [asking, setAsking] = useState<CardQuestion | null>(null);
  const keepButton = useRef<HTMLButtonElement | null>(null);
  // Whether the server has link Insights: the card has no capabilities of
  // its own, so it asks Rust once. Unknown reads as no, so nothing shows
  // that cannot open.
  const [insightsAvailable, setInsightsAvailable] = useState(false);
  // The bar's tooltip, shown for what Rust's pointer is on (and, when the
  // window does get hover or focus, from the elements' own events).
  const { tipProps, showAt, tooltip } = useBarTooltip();
  // What the pointer is on, by its `data-card-tip` key.
  const [pointed, setPointed] = useState<string | null>(null);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const cardId = useRef<number | null>(null);
  const copiedTimer = useRef<number | null>(null);

  const clearCopied = useCallback(() => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = null;
    setCopied(false);
    setCopyFailed(false);
  }, []);

  useEffect(() => {
    let heard = false;
    void getCapturePreview()
      .then((c) => !heard && setCard(c))
      .catch(() => undefined);
    const unlisten = onTauriEvent<CapturePreviewCard | null>("capture_preview_changed", (e) => {
      heard = true;
      setCard(e.payload);
    });
    return () => {
      unlisten();
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
      onTauriEvent<RemoteUploadProgress>("remote_upload_progress", (e) => setRow(e.payload)),
      onTauriEvent<SyncSnapshot>("sync_progress_snapshot", (e) => setSyncFiles(e.payload.files)),
    ];
    return () => {
      for (const stop of unlisteners) stop();
    };
  }, [followingId]);

  // A new capture replaced this card: forget the old one's progress.
  useEffect(() => {
    if (card && card.id !== cardId.current) {
      cardId.current = card.id;
      setRow(null);
      setSyncFiles([]);
      setMenuOpen(false);
      setAsking(null);
      clearCopied();
    }
  }, [card, clearCopied]);

  useEffect(() => clearCopied, [clearCopied]);

  const hasLinkToManage = card?.actions.manageLink ?? false;
  useEffect(() => {
    if (!hasLinkToManage) return;
    let alive = true;
    void getEngagementFeatures()
      .then((f) => alive && setInsightsAvailable(f.insights))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hasLinkToManage]);

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

  // Asking: focus starts on the safe answer, and Escape means no.
  useEffect(() => {
    if (!asking) return;
    keepButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setAsking(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking]);

  const view = card ? cardView(card, row, syncFiles) : null;
  const done = view?.done ?? false;
  const settled = view?.settled ?? false;

  // Once in the drive with its link settled, the card slides away on its own
  // after AUTO_HIDE_MS. Not before the link: it would go before it could say
  // the link was copied. The pointer on it, or keyboard focus in it, holds
  // the countdown, and letting go runs it on with the time it had left
  // (`autoHide.ts`): leaving never starts the wait over.
  // macOS sends no hover to the card's window (it is never key), so while
  // the card is up, ask Rust where the pointer is: on the card it holds the
  // card the same way, and what it is on is lit and named in the tooltip.
  const cardBox = useRef<HTMLDivElement | null>(null);
  const up = card !== null;
  useEffect(() => {
    if (!up) return;
    let inside = false;
    let on: string | null = null;
    let stopped = false;
    const poll = window.setInterval(() => {
      void getCapturePreviewPointer()
        .then((at) => {
          const box = cardBox.current?.getBoundingClientRect();
          if (stopped || !box) return;
          const now = !!at && at[0] >= box.left && at[0] <= box.right && at[1] >= box.top && at[1] <= box.bottom;
          const el = at ? markedAt({ x: at[0], y: at[1] }, { left: 0, top: 0 }, CARD_TIP) : null;
          const key = el?.getAttribute(CARD_TIP) ?? null;
          if (key !== on) {
            on = key;
            setPointed(key);
            showAt(key, el);
          }
          if (now === inside) return;
          inside = now;
          setHovered(now);
        })
        .catch(() => undefined);
    }, POINTER_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(poll);
    };
  }, [up, showAt]);

  // Focus and blur keep `keyboardIn` up to date, but a focused button that
  // goes away (a More item closing its menu) takes the focus with it and no
  // blur reaches React, so it is read again after every render too. Only
  // while the card's window has focus: switching to another app lets go,
  // though the button stays the page's active element.
  const readKeyboard = useCallback(() => {
    const el = document.activeElement;
    setKeyboardIn(document.hasFocus() && !!el && !!cardBox.current?.contains(el) && isKeyboardFocus(el));
  }, []);
  useLayoutEffect(readKeyboard);

  // A question, or a failed copy, holds the card too: it must not slide
  // away mid-answer or before Try again.
  const held = hovered || keyboardIn || asking !== null || copyFailed;
  const countingFor = settled && card ? card.id : null;
  // Before paint, so the timer bar is never drawn a frame behind the hold.
  useLayoutEffect(() => {
    setCountdown((previous) => nextCountdown(previous, countingFor, held, AUTO_HIDE_MS, performance.now()));
  }, [countingFor, held]);

  useEffect(() => {
    if (!countdown || countdown.runningSince === null) return;
    const id = countdown.cardId;
    const t = window.setTimeout(
      () => void dismissCapturePreview(id).catch(() => undefined),
      timeLeft(countdown, performance.now()),
    );
    return () => window.clearTimeout(t);
  }, [countdown]);

  if (!card || !view) return null;
  const { percent, failed, waiting } = view;
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
  // A screenshot's picture opens the editor, as macOS's thumbnail opens
  // Markup; anything else (a recording) still shows its folder.
  const canEdit = actions.edit === true;
  const edit = () => run(editCapturePreview);

  const copy = () => {
    setCopyFailed(false);
    void copyCapturePreviewLink()
      .then(() => {
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        setCopied(true);
        copiedTimer.current = window.setTimeout(() => {
          copiedTimer.current = null;
          setCopied(false);
        }, COPIED_MS);
      })
      .catch(() => {
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = null;
        setCopied(false);
        setCopyFailed(true);
      });
  };

  return (
    <div className="flex h-full w-full items-end justify-end p-1.5">
      <div
        ref={cardBox}
        data-testid="capture-card"
        className={`capture-card-enter relative w-full overflow-hidden rounded-[14px] p-2 ${GLASS_PANEL}`}
        // Mouse events too: a window that is not key may get no pointer events
        // on some WebViews, and the hold must work there as well.
        onPointerEnter={() => setHovered(true)}
        onMouseEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onMouseLeave={() => setHovered(false)}
        onFocus={readKeyboard}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyboardIn(false);
        }}
      >
        <div className="mb-1.5 flex h-7 items-center gap-2 pl-0.5">
          <p className="min-w-0 flex-1 truncate text-[13px] font-semibold" data-card-tip="name" {...tipProps("name", { label: card.fileName })}>
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
          onClick={failed ? undefined : canEdit ? edit : showInFolder}
          aria-label={canEdit ? `Edit ${card.fileName}` : `Show ${card.fileName} in its folder`}
          // Its hover face says what a click does; no tooltip repeats it.
          data-card-tip="picture"
          data-hover={pointed === "picture" ? "true" : undefined}
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
            <span className="pointer-events-none absolute inset-0 grid place-items-center bg-[#000]/0 opacity-0 transition duration-150 group-hover:bg-[#000]/35 group-hover:opacity-100 group-data-[hover=true]:bg-[#000]/35 group-data-[hover=true]:opacity-100 motion-reduce:transition-none">
              <span className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#000]/70 px-3 py-1 text-[12px] font-medium">
                {canEdit ? (
                  <>
                    <Pencil className="size-3.5" /> Edit
                  </>
                ) : (
                  <>
                    <FolderOpen className="size-3.5" /> Show in folder
                  </>
                )}
              </span>
            </span>
          )}
        </button>

        <div className="mt-2 flex flex-col gap-1 px-0.5">
          {/* Only the status line is live: wrapping the card re-announced
              every button whenever anything on it changed. */}
          <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-[12px] leading-[18px] text-white/75">
            {uploaded && <Check aria-hidden className="size-3.5 shrink-0 text-[#30D158]" />}
            {waiting && <Clock aria-hidden className="size-3.5 shrink-0 text-white/60" />}
            {failed && !waiting && <AlertCircle aria-hidden className="size-3.5 shrink-0 text-[#FF453A]" />}
            <span className="truncate">{view.text}</span>
          </p>
          {asking ? (
            // The question takes the second line's place, so the card keeps
            // its height and nothing is cut off at the top.
            <p id="card-question" className="line-clamp-2 text-[11.5px] leading-4 text-white/90" data-testid="capture-question">
              {CARD_QUESTION[asking].text}
            </p>
          ) : copyFailed ? (
            <p role="alert" className="truncate text-[11.5px] leading-4 text-[#FF8A80]" data-testid="capture-copy-failed">
              Couldn&apos;t copy the link.
            </p>
          ) : card.notice ? (
            // Rust's line about the capture (a Free plan recording stopped at
            // its limit) takes the destination's place, two lines at most.
            <p className="line-clamp-2 text-[11.5px] leading-4 text-white/85" data-testid="capture-notice">
              {card.notice}
            </p>
          ) : card.linkNote ? (
            // A public link says who can open it, in the destination's place
            // (still in the tooltip) so the card keeps its height. More >
            // Manage link changes it.
            <p
              className={`truncate text-[11.5px] leading-4 ${GLASS_MUTED}`}
              data-card-tip="destination"
              {...tipProps("destination", { label: destinationText(card) })}
              data-testid="capture-link-note"
            >
              {card.linkNote}
            </p>
          ) : (
            <p
              className={`truncate text-[11.5px] leading-4 ${GLASS_MUTED}`}
              data-card-tip="destination"
              {...tipProps("destination", { label: destinationText(card) })}
            >
              {destinationText(card)}
            </p>
          )}
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
            // Stays put while held, paused, so the card does not change
            // height under the pointer, and runs on from there when let go.
            // Each pause draws it afresh where the countdown stopped (a
            // negative delay), so the bar and the timer cannot drift apart.
            <div className="h-0.5 overflow-hidden rounded-full bg-white/10" aria-hidden data-testid="auto-hide-timer">
              {countdown && (
                <div
                  key={`${countdown.cardId}:${countdown.leftMs}`}
                  className="capture-card-timer h-full bg-white/35"
                  style={{
                    animationDuration: `${countdown.totalMs}ms`,
                    animationDelay: `${-barOffsetMs(countdown)}ms`,
                    animationPlayState: countdown.runningSince === null ? "paused" : "running",
                  }}
                />
              )}
            </div>
          )}
          {failure && !asking && (
            <p className={`line-clamp-1 text-[11.5px] leading-4 ${GLASS_MUTED}`} data-card-tip="failure" {...tipProps("failure", { label: failure })}>
              {failure}
            </p>
          )}
        </div>

        <div className="relative mt-2 flex gap-1.5" data-testid="capture-actions">
          {asking ? (
            <div role="group" aria-labelledby="card-question" className="flex w-full gap-1.5">
              <button ref={keepButton} type="button" onClick={() => setAsking(null)} className={SECONDARY_ACTION}>
                {CARD_QUESTION[asking].keep}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const action = asking === "discard" ? discardCapturePreview : revokeCapturePreviewLink;
                  setAsking(null);
                  run(action);
                }}
                className={DANGER_ACTION}
              >
                {CARD_QUESTION[asking].confirm}
              </button>
            </div>
          ) : failed ? (
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
                  {waiting ? (
                    // Nothing went wrong: Retry here only asks for the folder.
                    <>
                      <FolderPlus aria-hidden className="size-3.5 shrink-0" /> Choose folder
                    </>
                  ) : (
                    <>
                      <RotateCw aria-hidden className="size-3.5 shrink-0" /> Retry
                    </>
                  )}
                </button>
              )}
              {actions.discard &&
                (actions.upgrade && actions.retry ? (
                  // Three text buttons do not fit on one line: Discard becomes an icon.
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Discard"
                    data-card-tip="discard"
                    {...tipProps("discard", { label: "Discard" })}
                    onClick={() => setAsking("discard")}
                    className={ICON_ACTION}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => setAsking("discard")} className={SECONDARY_ACTION}>
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
              {actions.upgrade ? (
                // Show in folder stays one click away on the picture.
                <button type="button" onClick={() => run(upgradeFromCapturePreview)} className={PRIMARY_ACTION}>
                  <Sparkles aria-hidden className="size-3.5 shrink-0" /> Upgrade
                </button>
              ) : (
                <button type="button" onClick={showInFolder} className={PRIMARY_ACTION}>
                  <FolderOpen aria-hidden className="size-3.5 shrink-0" /> Show in folder
                </button>
              )}
              {actions.mintLink ? (
                <button type="button" disabled={busy} onClick={() => run(mintCapturePreviewLink)} className={SECONDARY_ACTION}>
                  <Link2 aria-hidden className="size-3.5 shrink-0" /> Create link
                </button>
              ) : (
                <button type="button" disabled={!actions.copyLink} onClick={copy} className={SECONDARY_ACTION}>
                  {copied ? (
                    <Check aria-hidden className="size-3.5 shrink-0" />
                  ) : copyFailed ? (
                    <RotateCw aria-hidden className="size-3.5 shrink-0" />
                  ) : (
                    <Link2 aria-hidden className="size-3.5 shrink-0" />
                  )}
                  {copied ? "Copied" : copyFailed ? "Try again" : "Copy link"}
                </button>
              )}
              {(actions.reveal || actions.revokeLink || actions.manageLink || canEdit) && (
                <button
                  ref={menuButton}
                  type="button"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  data-card-tip="more"
                  {...tipProps("more", { label: "More" })}
                  onClick={() => setMenuOpen((open) => !open)}
                  className={ICON_ACTION}
                >
                  <MoreHorizontal aria-hidden className="size-4" />
                </button>
              )}
              {menuOpen && (actions.reveal || actions.revokeLink || actions.manageLink || canEdit) && (
                // Opens upward over the picture: the card sits at the window's
                // bottom edge, so there is no room below.
                <div
                  ref={menu}
                  role="menu"
                  aria-label="More"
                  className={`absolute bottom-10 right-0 z-10 min-w-[170px] rounded-[10px] p-1 ${GLASS_PANEL}`}
                >
                  {canEdit && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        edit();
                      }}
                      className={MENU_ITEM}
                    >
                      <Pencil aria-hidden className="size-3.5 shrink-0" /> Edit screenshot
                    </button>
                  )}
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
                  {actions.manageLink && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        run(manageCapturePreviewLink);
                      }}
                      className={MENU_ITEM}
                    >
                      <Settings2 aria-hidden className="size-3.5 shrink-0" /> Manage link
                    </button>
                  )}
                  {actions.manageLink && insightsAvailable && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        run(openCapturePreviewInsights);
                      }}
                      className={MENU_ITEM}
                    >
                      <BarChart3 aria-hidden className="size-3.5 shrink-0" /> Insights
                    </button>
                  )}
                  {actions.revokeLink && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        setMenuOpen(false);
                        setAsking("revoke");
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
      {/* Not over an open More menu, which opens upward where it would go. */}
      {!menuOpen && tooltip}
    </div>
  );
}
