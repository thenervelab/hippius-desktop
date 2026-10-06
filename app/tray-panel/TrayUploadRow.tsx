"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal } from "lucide-react";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import { getFileTypeFromExtension } from "@/app/lib/utils/getTileTypeFromExtension";
import { getFileIcon, DIRECTORY_SUFFIX } from "@/app/lib/utils/fileTypeUtils";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { formatUploadedDate } from "@/app/lib/utils/formatUploadedDate";
import { fileManagerLabel } from "@/app/lib/utils/isMacPlatform";
import {
  getTrayQuickActions,
  getTrayRowActions,
  type TrayRowActionId,
} from "@/app/lib/tray/trayRowActions";
import TrayRowMenu, { TRAY_ACTION_ICONS, type TrayMenuAnchor } from "./TrayRowMenu";
import { copyTrayRowLink, runTrayRowAction } from "./trayMainWindow";

/** How long "Link copied" stays before the time comes back. */
const COPIED_MS = 1800;
/** A failure is read, so it stays longer. */
const FAILED_MS = 4000;

type Feedback =
  | { kind: "working" }
  | { kind: "copied"; reused: boolean }
  | { kind: "failed"; message: string };

/** Hover button names and tooltips. */
const QUICK_LABELS: Partial<Record<TrayRowActionId, string>> = {
  "show-in-drive": "Show in Hippius",
  "copy-link": "Copy link",
  preview: "View",
};

/**
 * One upload row. Layout mirrors the Figma: the file-type icon aligns with
 * the filename on the top line, and the size sits below, sharing that bottom
 * line with the right-aligned time or live status.
 *
 * File actions, modelled on menu bar upload lists (Zight, CleanShot Cloud):
 * - a three-dots button at the end of the name line, and a right click
 *   anywhere on the row, open the same menu (`getTrayRowActions`);
 * - beside the size, a few quick icon buttons (`getTrayQuickActions`) fade in
 *   on hover and on keyboard focus. They are always laid out, only hidden, so
 *   the row never changes height or shifts when they appear.
 *
 * "Copy link" reports on the row itself, in the time's place: the popover has
 * no toaster, and the result must be seen where the button was pressed.
 */
export default function TrayUploadRow({
  item,
  accountId,
}: {
  item: UploadFeedItem;
  /** The signed-in account, for revealing a file by drive and name. */
  accountId: string | null;
}) {
  const rawName = item.actualFileName || item.name;
  const ext = rawName.includes(".") ? (rawName.split(".").pop() ?? null) : null;
  const fileType = getFileTypeFromExtension(ext);
  const { icon: Icon, color } = getFileIcon(fileType ?? undefined, false);
  const name = displayFileName(item.name);

  const sizeText =
    typeof item.size === "number" && item.size > 0
      ? formatBytes(item.size)
      : "—";
  const uploadedText =
    item.feedStatus === "completed" ? formatUploadedDate(item.createdAt) : null;

  const actions = getTrayRowActions(item, fileManagerLabel());
  const quick = getTrayQuickActions(item);

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
      const failure = await runTrayRowAction(id, item, accountId);
      if (failure) showFeedback({ kind: "failed", message: failure }, FAILED_MS);
    },
    [accountId, copyLink, item, showFeedback],
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
  const label = `Actions for ${name}`;

  return (
    <li
      className="group relative -mx-2 flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-[rgba(0,0,0,0.03)] focus-within:bg-[rgba(0,0,0,0.03)] dark:hover:bg-white/[0.04] dark:focus-within:bg-white/[0.04]"
      onContextMenu={(event) => {
        if (actions.length === 0) return;
        event.preventDefault();
        openedFromTrigger.current = false;
        setMenuAnchor({ x: event.clientX, y: event.clientY });
      }}
    >
      {/* Icon column is as tall as the filename's line box and centers the
          icon within it, so the icon lines up with the filename row. */}
      <span
        className={`flex h-5 w-4 shrink-0 items-center justify-center ${color}`}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <MiddleEllipsisName name={name} />
          </div>
          {actions.length > 0 && (
            <button
              ref={triggerRef}
              type="button"
              aria-label={`More actions for ${name}`}
              title="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => (menuOpen ? closeMenu() : openFromTrigger())}
              className={`-my-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-black/60 outline-none transition-opacity hover:bg-[rgba(0,0,0,0.06)] focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-[#3167DD] dark:text-white/70 dark:hover:bg-white/10 ${
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-geist text-[12px] font-medium leading-normal tracking-[-0.24px] text-grey-10 dark:text-white">
              {sizeText}
            </span>
            {quick.length > 0 && (
              <span
                data-testid="tray-row-quick-actions"
                className={`flex shrink-0 items-center gap-0.5 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${
                  menuOpen || feedback ? "opacity-100" : "opacity-0"
                }`}
              >
                {quick.map((id) => {
                  const QuickIcon =
                    id === "copy-link" && feedback?.kind === "copied"
                      ? Check
                      : TRAY_ACTION_ICONS[id];
                  const name = QUICK_LABELS[id] ?? id;
                  const busy = id === "copy-link" && feedback?.kind === "working";
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-label={`${name}: ${displayFileName(item.name)}`}
                      title={name}
                      aria-busy={busy || undefined}
                      onClick={() => void run(id)}
                      className={`-my-1 flex size-6 items-center justify-center rounded-md outline-none transition-colors hover:bg-[rgba(0,0,0,0.06)] focus-visible:ring-1 focus-visible:ring-[#3167DD] dark:hover:bg-white/10 ${
                        id === "copy-link" && feedback?.kind === "copied"
                          ? "text-[#04C870]"
                          : "text-black/55 hover:text-black dark:text-white/60 dark:hover:text-white"
                      } ${busy ? "animate-pulse" : ""}`}
                    >
                      <QuickIcon className="size-3.5" aria-hidden />
                    </button>
                  );
                })}
              </span>
            )}
          </div>
          <RowStatus
            feedback={feedback}
            uploadedText={uploadedText}
            item={item}
          />
        </div>
      </div>
      {menuAnchor && (
        <TrayRowMenu
          actions={actions}
          anchor={menuAnchor}
          label={label}
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

/** The right end of the bottom line: an action's result while there is one,
 *  else the upload time (completed) or the live status. Announced politely so
 *  a screen reader hears "Link copied" without moving focus. */
function RowStatus({
  feedback,
  uploadedText,
  item,
}: {
  feedback: Feedback | null;
  uploadedText: string | null;
  item: UploadFeedItem;
}) {
  const base =
    "shrink-0 font-geist text-[12px] font-medium tracking-[-0.24px]";
  let content: React.ReactNode;
  if (feedback?.kind === "working") {
    content = (
      <span className={`${base} animate-pulse text-[#3167DD]`}>
        Getting link…
      </span>
    );
  } else if (feedback?.kind === "copied") {
    content = (
      <span className={`${base} text-[#04C870]`}>Link copied</span>
    );
  } else if (feedback?.kind === "failed") {
    content = (
      <span
        className={`${base} max-w-[60%] truncate text-[#FF6D61]`}
        title={feedback.message}
      >
        {feedback.message}
      </span>
    );
  } else if (uploadedText) {
    content = (
      <span className={`${base} text-grey-10 dark:text-white/50`}>
        {uploadedText}
      </span>
    );
  } else {
    content = (
      <StatusLabel status={item.feedStatus} progress={item.progressPercent} />
    );
  }
  return (
    <span aria-live="polite" className="flex min-w-0 shrink-0 justify-end">
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
      <p className={`truncate ${textClass}`} title={name}>
        {name}
      </p>
    );
  }

  const head = name.slice(0, name.length - TAIL_CHARS);
  const tail = name.slice(name.length - TAIL_CHARS);
  return (
    <p className={`flex min-w-0 ${textClass}`} title={name}>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </p>
  );
}

/** Small circular progress ring shown beside the "time left" status while a
 *  file is uploading; mirrors the drive page's ring. `value` is 0 to 100. */
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

/** Color-coded status label (Geist Mono, 10px, uppercase, Figma tokens). */
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
    completed: { label: "UPLOADED", className: "text-[#04C870]" },
    uploaded: { label: "UPLOADED", className: "text-[#04C870]" },
    pending: { label: "PENDING", className: "text-[#FEB101]" },
    failed: { label: "FAILED", className: "text-[#FF6D61]" },
    deleted: {
      label: "DELETED",
      className: "text-black/40 dark:text-white/40",
    },
  };
  const entry = map[status] ?? {
    label: status.toUpperCase(),
    className: "text-black/40 dark:text-white/40",
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
