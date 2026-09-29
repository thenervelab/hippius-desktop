"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppWindow, Loader2, Monitor } from "lucide-react";
import {
  finishCaptureShare,
  getCaptureShareTargets,
  type CaptureKind,
  type ShareArt,
  type ShareTab,
  type ShareTargets,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { confirmLabel } from "./barText";
import {
  displayCaption,
  initialPick,
  livePick,
  mergeShareArt,
  tileAspect,
  windowCaption,
  type SharePick,
} from "./sharePickerState";

/**
 * "Choose what to share", the way Chrome and Loom ask: a Window tab and an
 * Entire Screen tab, each a grid of live pictures, then Capture / Record.
 * Opened from the bar's Choose button; Rust lists what can be shared and
 * streams the pictures in (`capture_share_targets`, `capture_share_art`).
 *
 * It owns Return, Escape and the arrow keys while it is open; the overlay
 * page leaves them to it.
 */

const TABS: { tab: ShareTab; label: string; Icon: typeof Monitor }[] = [
  { tab: "window", label: "Window", Icon: AppWindow },
  { tab: "screen", label: "Entire Screen", Icon: Monitor },
];

export interface SharePickerProps {
  kind: CaptureKind;
  firstTab: ShareTab;
  /** The display the bar is on: its screen is picked when the picker opens. */
  barDisplayId: number;
  onChoose: (pick: SharePick) => void;
  onClose: () => void;
}

function Tile({
  picked,
  caption,
  subcaption,
  icon,
  thumbnail,
  aspect,
  onPick,
  onChoose,
}: {
  picked: boolean;
  caption: string;
  subcaption?: string;
  icon?: string | null;
  thumbnail: string | null;
  aspect: number;
  onPick: () => void;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={picked}
      title={subcaption ? `${caption} (${subcaption})` : caption}
      onClick={onPick}
      onDoubleClick={onChoose}
      className={`group flex min-w-0 flex-col gap-2 rounded-[12px] p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#3167DD] ${
        picked ? "bg-[#3167DD]/25 ring-2 ring-[#3167DD]" : "hover:bg-white/[0.07]"
      }`}
    >
      <span className="grid h-[132px] w-full place-items-center overflow-hidden rounded-[8px] bg-black/40">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
        ) : (
          <span
            aria-hidden
            className="max-h-full w-[70%] animate-pulse rounded-[4px] bg-white/[0.08]"
            style={{ aspectRatio: aspect }}
          />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-2 px-0.5">
        {icon && (
          <img src={icon} alt="" className="size-4 shrink-0" draggable={false} />
        )}
        <span className="min-w-0">
          <span className="block truncate text-[12.5px] font-medium text-white/90">{caption}</span>
          {subcaption && <span className="block truncate text-[11.5px] text-white/50">{subcaption}</span>}
        </span>
      </span>
    </button>
  );
}

export default function SharePicker({ kind, firstTab, barDisplayId, onChoose, onClose }: SharePickerProps) {
  const [tab, setTab] = useState<ShareTab>(firstTab);
  const [targets, setTargets] = useState<ShareTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<SharePick | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // The list now, pictures as they come; stop the pictures on close.
  useEffect(() => {
    let token: number | null = null;
    let closed = false;
    const unlisten = listen<ShareArt>("capture_share_art", (e) =>
      setTargets((t) => (t ? mergeShareArt(t, e.payload) : t)),
    );
    getCaptureShareTargets(firstTab)
      .then((t) => {
        if (closed) {
          void finishCaptureShare(t.token).catch(() => undefined);
          return;
        }
        token = t.token;
        setTargets(t);
        setPick(initialPick(firstTab, t, barDisplayId));
      })
      .catch((e) => {
        if (!closed) setError(errorMessage(e));
      });
    return () => {
      closed = true;
      void unlisten.then((fn) => fn());
      if (token !== null) void finishCaptureShare(token).catch(() => undefined);
    };
  }, [firstTab, barDisplayId]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const current = targets ? livePick(pick, targets) : null;
  const pickedHere = current && current.tab === tab ? current : null;

  const switchTab = (next: ShareTab) => {
    setTab(next);
    if (targets && current?.tab !== next) setPick(initialPick(next, targets, barDisplayId));
  };

  const ids = useMemo(
    () => (targets ? (tab === "window" ? targets.windows : targets.displays).map((x) => x.id) : []),
    [targets, tab],
  );

  const choose = useCallback(() => {
    if (pickedHere) onChoose(pickedHere);
  }, [pickedHere, onChoose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose();
      } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && ids.length > 0) {
        e.preventDefault();
        const at = pickedHere ? ids.indexOf(pickedHere.id) : -1;
        const step = e.key === "ArrowRight" ? 1 : -1;
        const next = at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length;
        setPick({ tab, id: ids[next] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose, onClose, ids, pickedHere, tab]);

  const verb = kind === "recording" ? "record" : "capture";

  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-black/35 px-4 font-[system-ui,-apple-system,'Segoe_UI',sans-serif]"
      // The picker is a dialog over the selection surface, which must not
      // see its clicks (a click would pick the window underneath).
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-picker-title"
        tabIndex={-1}
        className="flex max-h-[80vh] w-full max-w-[880px] flex-col overflow-hidden rounded-[16px] border border-white/10 bg-[#1c1d21]/95 text-white shadow-[0_24px_60px_rgba(0,0,0,0.55)] outline-none backdrop-blur-xl"
      >
        <div className="px-5 pb-3 pt-4">
          <h2 id="share-picker-title" className="text-[15px] font-semibold">
            Choose what to share
          </h2>
          <p className="mt-0.5 text-[12.5px] text-white/55">
            Hippius will {verb} the {tab === "window" ? "window" : "screen"} you choose.
          </p>
          <div role="tablist" aria-label="What to share" className="mt-3 inline-flex rounded-[9px] bg-black/35 p-0.5">
            {TABS.map(({ tab: t, label, Icon }) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => switchTab(t)}
                className={`flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] transition-colors ${
                  tab === t ? "bg-white/15 text-white" : "text-white/65 hover:text-white"
                }`}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-[220px] flex-1 overflow-y-auto border-y border-white/10 px-3 py-3">
          {error ? (
            <p className="px-2 py-10 text-center text-[13px] text-white/70">{error}</p>
          ) : !targets ? (
            <p className="flex items-center justify-center gap-2 py-16 text-[13px] text-white/60">
              <Loader2 className="size-4 animate-spin" />
              Finding windows and screens…
            </p>
          ) : tab === "window" && targets.windows.length === 0 ? (
            <p className="px-2 py-10 text-center text-[13px] leading-relaxed text-white/65">
              No windows to share. Open the window you want first, or share an entire screen.
            </p>
          ) : (
            <div
              role="listbox"
              aria-label={tab === "window" ? "Windows" : "Screens"}
              className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-1.5"
            >
              {tab === "window"
                ? targets.windows.map((w) => {
                    const c = windowCaption(w);
                    return (
                      <Tile
                        key={w.id}
                        picked={pickedHere?.id === w.id}
                        caption={c.title}
                        subcaption={c.app || undefined}
                        icon={w.icon}
                        thumbnail={w.thumbnail}
                        aspect={tileAspect(w.width, w.height)}
                        onPick={() => setPick({ tab: "window", id: w.id })}
                        onChoose={() => onChoose({ tab: "window", id: w.id })}
                      />
                    );
                  })
                : targets.displays.map((d, i) => (
                    <Tile
                      key={d.id}
                      picked={pickedHere?.id === d.id}
                      caption={displayCaption(d, i)}
                      thumbnail={d.thumbnail}
                      aspect={tileAspect(d.width, d.height)}
                      onPick={() => setPick({ tab: "screen", id: d.id })}
                      onChoose={() => onChoose({ tab: "screen", id: d.id })}
                    />
                  ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-[8px] px-3.5 text-[13px] text-white/80 hover:bg-white/10 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!pickedHere}
            onClick={choose}
            className="h-8 rounded-[8px] bg-[#3167DD] px-4 text-[13px] font-semibold text-white hover:bg-[#2a5bc6] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {confirmLabel(kind)}
          </button>
        </div>
      </div>
    </div>
  );
}
