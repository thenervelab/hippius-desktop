"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Check, Link2, MoreHorizontal, PenLine, Play } from "lucide-react";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import { getFileTypeFromExtension } from "@/app/lib/utils/getTileTypeFromExtension";
import { getFileIcon, DIRECTORY_SUFFIX } from "@/app/lib/utils/fileTypeUtils";
import { fileManagerLabel } from "@/app/lib/utils/isMacPlatform";
import {
  getTrayQuickActions,
  getTrayRowActions,
  trayRowOpensViewer,
  type TrayRowActionId,
} from "@/app/lib/tray/trayRowActions";
import { formatClipDuration, trayRowSubtitle } from "@/app/lib/tray/trayRowDisplay";
import TrayRowMenu, { type TrayMenuAnchor } from "./TrayRowMenu";
import { copyTrayRowLink, runTrayRowAction } from "./trayMainWindow";
import {
  forgetTrayThumbnail,
  useTrayThumbnail,
  type TrayRowPicture,
} from "./useTrayThumbnail";

/** How long "Link copied" stays before the subtitle comes back. */
const COPIED_MS = 1800;
/** A failure is read, so it stays longer. */
const FAILED_MS = 4000;

type Feedback =
  | { kind: "working" }
  | { kind: "copied"; reused: boolean }
  | { kind: "failed"; message: string };

/**
 * One file row: a picture of the file on the left (the screenshot itself,
 * a frame of a recording with its length, else the file-type icon), the
 * name, and "Screenshot · 1.7 MB · 5m ago" under it.
 *
 * File actions, modelled on menu bar upload lists (Zight, CleanShot Cloud):
 * - on hover or keyboard focus, Copy link (the primary action, brand blue)
 *   and, for a picture, Edit slide in at the row's end
 *   (`getTrayQuickActions`);
 * - the three-dots button, and a right click anywhere on the row, open the
 *   full menu (`getTrayRowActions`).
 *
 * Pressing the picture or the name (or Return on it) opens the file in the
 * app's viewer in the main window, the menu's "View": a finished file the
 * viewer can show (`trayRowOpensViewer`). The hover actions are siblings of
 * that button, never inside it, so a press on one never opens the viewer.
 *
 * "Copy link" reports on the row itself, in the subtitle's place: the
 * popover has no toaster, and the result must be seen where the button was
 * pressed.
 */
export default function TrayUploadRow({
  item,
  accountId,
  isCapture = false,
  siblings,
  editorEnabled = false,
}: {
  item: UploadFeedItem;
  /** The signed-in account, for revealing a file and fetching its picture. */
  accountId: string | null;
  /** Rust listed it as a capture: its subtitle says Screenshot or Recording. */
  isCapture?: boolean;
  /** The files the viewer can walk from this one: the tab it is listed in. */
  siblings?: UploadFeedItem[];
  /**
   * Capture is on for this computer (flag AND Rust's support), so a picture
   * offers Edit (the screenshot editor). Off until Rust has answered.
   */
  editorEnabled?: boolean;
}) {
  const name = displayFileName(item.name);
  const picture = useTrayThumbnail(item, accountId);

  const actions = getTrayRowActions(item, fileManagerLabel(), editorEnabled);
  const quick = getTrayQuickActions(item, editorEnabled);
  const opensViewer = trayRowOpensViewer(item);
  const subtitleId = useId();

  const [menuAnchor, setMenuAnchor] = useState<TrayMenuAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openedFromTrigger = useRef(false);

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(feedbackTimer.current), []);
  const showFeedback = useCallback((next: Feedback | null, ms?: number) => {
    window.clearTimeout(feedbackTimer.current);
    setFeedback(next);
    if (ms) {
      feedbackTimer.current = window.setTimeout(() => setFeedback(null), ms);
    }
  }, []);

  const copyLink = useCallback(async () => {
    if (feedback?.kind === "working") return;
    showFeedback({ kind: "working" });
    const outcome = await copyTrayRowLink(item);
    if (outcome.status === "copied") {
      showFeedback({ kind: "copied", reused: outcome.reused }, COPIED_MS);
    } else {
      showFeedback({ kind: "failed", message: outcome.message }, FAILED_MS);
    }
  }, [feedback, item, showFeedback]);

  const run = useCallback(
    async (id: TrayRowActionId) => {
      if (id === "copy-link") {
        await copyLink();
        return;
      }
      const failure = await runTrayRowAction(
        id,
        item,
        accountId,
        id === "preview" ? siblings : undefined,
      );
      if (failure) showFeedback({ kind: "failed", message: failure }, FAILED_MS);
    },
    [accountId, copyLink, item, showFeedback, siblings],
  );

  const closeMenu = useCallback(() => {
    setMenuAnchor(null);
    if (openedFromTrigger.current) triggerRef.current?.focus();
    openedFromTrigger.current = false;
  }, []);

  const openFromTrigger = () => {
    const box = triggerRef.current?.getBoundingClientRect();
    if (!box) return;
    openedFromTrigger.current = true;
    // Right-aligned under the dots, like a native pull-down.
    setMenuAnchor({ x: box.right - 200, y: box.bottom + 4 });
  };

  const menuOpen = menuAnchor !== null;
  // Kept out while something is said in the subtitle's place, so a result is
  // never read beside the buttons that would repeat it.
  const pinned = menuOpen || feedback?.kind === "working";

  return (
    <li
      className="group relative -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[rgba(0,0,0,0.03)] focus-within:bg-[rgba(0,0,0,0.03)] dark:hover:bg-white/[0.04] dark:focus-within:bg-white/[0.04]"
      onContextMenu={(event) => {
        if (actions.length === 0) return;
        event.preventDefault();
        openedFromTrigger.current = false;
        setMenuAnchor({ x: event.clientX, y: event.clientY });
      }}
    >
      {opensViewer ? (
        <button
          type="button"
          data-testid="tray-row-open"
          aria-label={`View ${name}`}
          aria-describedby={subtitleId}
          onClick={() => void run("preview")}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-50 dark:focus-visible:ring-primary-brand-dark"
        >
          <RowThumbnail item={item} picture={picture} />
          <span className="block min-w-0 flex-1">
            <MiddleEllipsisName name={name} />
            <RowSubtitle id={subtitleId} item={item} feedback={feedback} isCapture={isCapture} />
          </span>
        </button>
      ) : (
        <>
          <RowThumbnail item={item} picture={picture} />
          <div className="min-w-0 flex-1">
            <MiddleEllipsisName name={name} />
            <RowSubtitle id={subtitleId} item={item} feedback={feedback} isCapture={isCapture} />
          </div>
        </>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {item.feedStatus !== "completed" && (
          <StatusLabel status={item.feedStatus} progress={item.progressPercent} />
        )}
        {quick.length > 0 && (
          <span
            data-testid="tray-row-quick-actions"
            // Laid out at zero width while hidden, so the name has the row
            // until the pointer or the keyboard arrives; still focusable,
            // and focus opens it (`group-focus-within`).
            className={`flex items-center gap-1 overflow-hidden transition-[max-width,opacity] duration-150 group-focus-within:max-w-[180px] group-focus-within:opacity-100 group-hover:max-w-[180px] group-hover:opacity-100 ${
              pinned ? "max-w-[180px] opacity-100" : "max-w-0 opacity-0"
            }`}
          >
            {quick.map((id) =>
              id === "copy-link" ? (
                <CopyLinkButton
                  key={id}
                  name={name}
                  feedback={feedback}
                  onClick={() => void run(id)}
                />
              ) : (
                <button
                  key={id}
                  type="button"
                  aria-label={`Edit: ${name}`}
                  title="Edit"
                  onClick={() => void run(id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[rgba(0,0,0,0.6)] outline-none transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-grey-10 focus-visible:ring-2 focus-visible:ring-primary-50 dark:text-white/70 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:ring-primary-brand-dark"
                >
                  <PenLine className="size-3.5" aria-hidden />
                </button>
              ),
            )}
          </span>
        )}
        {actions.length > 0 && (
          <button
            ref={triggerRef}
            type="button"
            aria-label={`More actions for ${name}`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : openFromTrigger())}
            className={`flex size-7 shrink-0 items-center justify-center rounded-lg text-[rgba(0,0,0,0.6)] outline-none transition-opacity hover:bg-[rgba(0,0,0,0.06)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary-50 group-focus-within:opacity-100 dark:text-white/70 dark:hover:bg-white/10 dark:focus-visible:ring-primary-brand-dark ${
              menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {menuAnchor && (
        <TrayRowMenu
          actions={actions}
          anchor={menuAnchor}
          label={`Actions for ${name}`}
          onClose={closeMenu}
          onSelect={(id) => {
            closeMenu();
            void run(id);
          }}
        />
      )}
    </li>
  );
}

/** The primary hover action, in brand blue; a tick while the copy shows. */
function CopyLinkButton({
  name,
  feedback,
  onClick,
}: {
  name: string;
  feedback: Feedback | null;
  onClick: () => void;
}) {
  const busy = feedback?.kind === "working";
  const copied = feedback?.kind === "copied";
  const Icon = copied ? Check : Link2;
  return (
    <button
      type="button"
      aria-label={`Copy link: ${name}`}
      title="Copy link"
      aria-busy={busy || undefined}
      onClick={onClick}
      className={`flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-primary-50 px-2.5 font-geist text-[12px] font-semibold text-white outline-none transition-colors hover:bg-primary-40 focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-1 dark:focus-visible:ring-primary-brand-dark ${
        busy ? "animate-pulse" : ""
      }`}
    >
      <Icon className="size-3.5" aria-hidden />
      Copy link
    </button>
  );
}

/**
 * The picture at the start of the row: the file's own thumbnail when Rust
 * made one (a recording carries a play badge and its length), else the
 * file-type icon, which is also what shows while the picture is made and if
 * it cannot be loaded.
 */
function RowThumbnail({
  item,
  picture,
}: {
  item: UploadFeedItem;
  picture: TrayRowPicture | null;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const rawName = item.actualFileName || item.name;
  const ext = rawName.includes(".") ? (rawName.split(".").pop() ?? null) : null;
  const fileType = getFileTypeFromExtension(ext);
  const { icon: Icon, color } = getFileIcon(fileType ?? undefined, Boolean(item.isFolder));
  const shown = picture && broken !== picture.url ? picture : null;
  const duration = shown?.kind === "video" ? formatClipDuration(shown.durationSecs) : null;

  return (
    <span className="relative flex h-[42px] w-16 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-[rgba(0,0,0,0.05)] dark:bg-white/[0.06]">
      {shown ? (
        <img
          data-testid="tray-row-thumbnail"
          src={shown.url}
          alt=""
          draggable={false}
          className="size-full object-cover"
          onError={() => {
            // The cached file went away: show the icon, and ask again next time.
            setBroken(shown.url);
            forgetTrayThumbnail(item);
          }}
        />
      ) : (
        <span data-testid="tray-row-icon" className={`flex ${color}`}>
          <Icon className="size-5" aria-hidden />
        </span>
      )}
      {shown?.kind === "video" && (
        <>
          <span
            data-testid="tray-row-play"
            aria-hidden
            className="absolute bottom-1 left-1 flex size-4 items-center justify-center rounded-full bg-[#000]/55"
          >
            <Play className="size-2 fill-white text-white" />
          </span>
          {duration && (
            <span className="absolute bottom-1 right-1 rounded-[4px] bg-[#000]/60 px-1 font-geist text-[9px] font-semibold leading-[14px] text-white">
              {duration}
            </span>
          )}
        </>
      )}
    </span>
  );
}

/** The line under the name: what the file is, or what an action just did.
 *  Announced politely so a screen reader hears "Link copied" without moving
 *  focus. */
function RowSubtitle({
  id,
  item,
  feedback,
  isCapture,
}: {
  id?: string;
  item: UploadFeedItem;
  feedback: Feedback | null;
  isCapture: boolean;
}) {
  const base =
    "mt-0.5 block truncate font-geist text-[12px] font-medium leading-4 tracking-[-0.24px]";
  let content: React.ReactNode;
  if (feedback?.kind === "working") {
    content = <span className={`${base} animate-pulse text-primary-50 dark:text-primary-brand-dark`}>Getting link…</span>;
  } else if (feedback?.kind === "copied") {
    content = <span className={`${base} text-[#04C870]`}>Link copied</span>;
  } else if (feedback?.kind === "failed") {
    content = (
      <span className={`${base} text-[#FF6D61]`} title={feedback.message}>
        {feedback.message}
      </span>
    );
  } else {
    content = (
      <span className={`${base} text-grey-70 dark:text-white/50`}>
        {trayRowSubtitle(item, isCapture)}
      </span>
    );
  }
  return (
    <span id={id} aria-live="polite" className="block min-w-0">
      {content}
    </span>
  );
}

/**
 * Center-truncate a filename with PURE CSS: no width measurement, so it is
 * immune to the webfont-load timing that left the canvas-measuring
 * `MiddleTruncatedName` clipping the extension in this provider-free webview.
 *
 * The head span truncates with the browser's own end-ellipsis; the tail span
 * (the last `TAIL_CHARS`: extension plus a little context) is `shrink-0`, so it
 * is always rendered in full. When the whole name fits, head sizes to its
 * content (no `flex-1`), so there's no gap before the tail and it reads as one
 * contiguous string; when it doesn't, only the head shrinks. The native `title`
 * shows the full name on hover.
 */
function MiddleEllipsisName({ name }: { name: string }) {
  const TAIL_CHARS = 10;
  const textClass =
    "font-geist text-[14px] font-medium leading-5 tracking-[-0.28px] text-[#1d1d1d] dark:text-white";

  if (name.length <= TAIL_CHARS + 1) {
    return (
      <span data-testid="tray-row-name" className={`block truncate ${textClass}`} title={name}>
        {name}
      </span>
    );
  }

  const head = name.slice(0, name.length - TAIL_CHARS);
  const tail = name.slice(name.length - TAIL_CHARS);
  return (
    <span data-testid="tray-row-name" className={`flex min-w-0 ${textClass}`} title={name}>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  );
}

/** Small circular progress ring shown while a file is uploading, and in the
 *  sync line; mirrors the drive page's ring. `value` is 0 to 100. */
export function ProgressRing({ value }: { value: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      className="-rotate-90 shrink-0"
      aria-hidden="true"
    >
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
      />
    </svg>
  );
}

/** Color-coded status of a file still on its way (Geist Mono, 10px, uppercase, Figma tokens). */
function StatusLabel({
  status,
  progress,
}: {
  status: string;
  progress?: number | null;
}) {
  const base =
    "shrink-0 font-mono text-[10px] font-medium uppercase leading-none tracking-[-0.2px]";

  // Uploading: brand-blue progress ring + live percent (falls back to the
  // "UPLOADING" word before the first percent arrives).
  if (status === "uploading") {
    return (
      <span className={`flex items-center gap-1.5 text-[#3167DD] ${base}`}>
        <ProgressRing value={progress ?? 0} />
        {typeof progress === "number"
          ? `${Math.round(progress)}%`
          : "UPLOADING"}
      </span>
    );
  }

  const map: Record<string, { label: string; className: string }> = {
    pending: { label: "PENDING", className: "text-[#FEB101]" },
    failed: { label: "FAILED", className: "text-[#FF6D61]" },
  };
  const entry = map[status] ?? {
    label: status.toUpperCase(),
    className: "text-[rgba(0,0,0,0.4)] dark:text-white/40",
  };
  return <span className={`${base} ${entry.className}`}>{entry.label}</span>;
}

/** Display name for an upload row: strip the internal `.ec_metadata` folder
 *  suffix, but do NOT length-truncate: CSS `truncate` ellipsizes based on the
 *  row's actual available width, so names use the full row before clipping. */
function displayFileName(rawName: string): string {
  return rawName.endsWith(DIRECTORY_SUFFIX)
    ? rawName.slice(0, -DIRECTORY_SUFFIX.length)
    : rawName;
}
