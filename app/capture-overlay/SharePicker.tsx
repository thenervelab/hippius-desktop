"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Monitor } from "lucide-react";
import {
  finishCaptureShare,
  getCaptureShareTargets,
  type CaptureKind,
  type ShareArt,
  type ShareTab,
  type ShareTargets,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { MODE_ICON } from "@/app/lib/capture/modes";
import { GLASS_BUTTON, GLASS_FOCUS, GLASS_MUTED, GLASS_PANEL, GLASS_PRIMARY } from "@/app/lib/capture/glass";
import { confirmLabel } from "./barText";
import {
  displayCaption,
  gridStep,
  initialPick,
  livePick,
  mergeShareArt,
  tileAspect,
  windowCaption,
  type SharePick,
} from "./sharePickerState";

/**
 * "Choose what to share", the way Chrome and Loom ask: a Window tab and an
 * Entire screen tab, each a grid of live pictures, then Capture / Record.
 * Opened from the bar's Choose button; Rust lists what can be shared and
 * streams the pictures in (`capture_share_targets`, `capture_share_art`).
 *
 * A modal dialog in full: it owns Return, Escape and the arrow keys while it
 * is open (the overlay page leaves them to it), keeps Tab inside itself, and
 * hands focus back to whatever opened it when it closes. The grid is one Tab
 * stop; the arrows move the pick in two dimensions and focus follows it.
 */

const TABS: { tab: ShareTab; label: string; Icon: typeof Monitor }[] = [
  { tab: "window", label: "Window", Icon: MODE_ICON.window },
  { tab: "screen", label: "Entire screen", Icon: MODE_ICON.screen },
];

/** The grid's minimum tile width, in points (the `minmax` below). */
const TILE_MIN = 190;

const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  kind: CaptureKind;
  firstTab: ShareTab;
  /** The display the bar is on: its screen is picked when the picker opens. */
  barDisplayId: number;
  onChoose: (pick: SharePick) => void;
  onClose: () => void;
}

function Tile({
  id,
  picked,
  caption,
  subcaption,
  icon,
  thumbnail,
  aspect,
  onPick,
  onChoose,
}: {
  id: number;
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
      data-tile-id={id}
      tabIndex={picked ? 0 : -1}
      title={subcaption ? `${caption} (${subcaption})` : caption}
      onClick={onPick}
      onDoubleClick={onChoose}
      className={`group flex min-w-0 flex-col gap-2 rounded-[12px] p-2 text-left transition-colors ${GLASS_FOCUS} ${
        picked ? "bg-[#3167DD]/25 ring-2 ring-[#3167DD]" : "hover:bg-white/[0.07]"
      }`}
    >
      <span className="grid h-[132px] w-full place-items-center overflow-hidden rounded-[8px] bg-[#000]/40">
        {thumbnail ? (
          <img src={thumbnail} alt="" className="max-h-full max-w-full object-contain" draggable={false} />
        ) : (
          <span
            aria-hidden
            className="max-h-full w-[70%] animate-pulse rounded-[4px] bg-white/[0.08] motion-reduce:animate-none"
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
          {subcaption && <span className={`block truncate text-[11.5px] ${GLASS_MUTED}`}>{subcaption}</span>}
        </span>
      </span>
    </button>
  );
}

export default function SharePicker({ kind, firstTab, barDisplayId, onChoose, onClose }: Props) {
  const [tab, setTab] = useState<ShareTab>(firstTab);
  const [targets, setTargets] = useState<ShareTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<SharePick | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<ShareTab, HTMLButtonElement | null>>>({});
  // A keyboard move asks for focus to follow the pick it made once that pick
  // is drawn. It names the pick, not just "a move happened": an effect still
  // pending from an earlier render (the list arriving) would otherwise take
  // the request and focus its own pick instead.
  const focusPick = useRef<SharePick | null>(null);

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

  // Focus the dialog on open, and give it back to what opened it on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
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
    const wanted = focusPick.current;
    if (!wanted || !pickedHere || wanted.tab !== pickedHere.tab || wanted.id !== pickedHere.id) return;
    focusPick.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-tile-id="${pickedHere.id}"]`)?.focus();
  }, [pickedHere]);

  // The key handler is re-made each render and published in a layout effect;
  // the window listener is bound once and calls whichever is current. A
  // listener re-bound in a passive effect kept the render with no pick until
  // React got round to that effect, so a Return right after the list drew
  // shared nothing.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useLayoutEffect(() => {
    const columns = () => {
      const list = listRef.current;
      if (!list) return 1;
      const template = getComputedStyle(list).gridTemplateColumns;
      const counted = template && template !== "none" ? template.split(" ").filter(Boolean).length : 0;
      return counted > 0 ? counted : Math.max(1, Math.floor(list.clientWidth / TILE_MIN));
    };
    const trapTab = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const stops = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    keyHandler.current = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        trapTab(e);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const target = e.target instanceof Element ? e.target : null;
      // On a tab, Left / Right switch tabs, as a tab strip does.
      if (target?.closest('[role="tablist"]') && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const at = TABS.findIndex((t) => t.tab === tab);
        const next = TABS[(at + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length].tab;
        switchTab(next);
        tabRefs.current[next]?.focus();
        return;
      }
      if (e.key === "Enter") {
        // Return on Cancel or a tab is that button's own.
        if (target?.closest("button") && !target.closest('[role="option"]')) return;
        e.preventDefault();
        choose();
        return;
      }
      const at = pickedHere ? ids.indexOf(pickedHere.id) : -1;
      const next = gridStep(e.key, at, ids.length, columns());
      if (next === null) return;
      e.preventDefault();
      const moved = { tab, id: ids[next] };
      focusPick.current = moved;
      setPick(moved);
    };
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const verb = kind === "recording" ? "record" : "capture";

  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-[#000]/35 px-4"
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
        className={`flex max-h-[80vh] w-full max-w-[880px] flex-col overflow-hidden rounded-[16px] outline-none ${GLASS_PANEL}`}
      >
        <div className="px-5 pb-3 pt-4">
          <h2 id="share-picker-title" className="text-[15px] font-semibold">
            Choose what to share
          </h2>
          <p className={`mt-0.5 text-[12.5px] ${GLASS_MUTED}`}>
            Hippius will {verb} the {tab === "window" ? "window" : "screen"} you choose.
          </p>
          <div role="tablist" aria-label="What to share" className="mt-3 inline-flex rounded-[9px] bg-[#000]/35 p-0.5">
            {TABS.map(({ tab: t, label, Icon }) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                id={`share-tab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls="share-panel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => switchTab(t)}
                className={`flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] transition-colors ${GLASS_FOCUS} ${
                  tab === t ? "bg-white/15 text-white" : "text-white/65 hover:text-white"
                }`}
              >
                <Icon aria-hidden className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div
          id="share-panel"
          role="tabpanel"
          aria-labelledby={`share-tab-${tab}`}
          className="min-h-[220px] flex-1 overflow-y-auto border-y border-white/10 px-3 py-3"
        >
          {error ? (
            <p className="px-2 py-10 text-center text-[13px] text-white/70">{error}</p>
          ) : !targets ? (
            <p className="flex items-center justify-center gap-2 py-16 text-[13px] text-white/60">
              <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
              Finding windows and screens…
            </p>
          ) : tab === "window" && targets.windows.length === 0 ? (
            <p className="px-2 py-10 text-center text-[13px] leading-relaxed text-white/65">
              No windows to share. Open the window you want first, or share an entire screen.
            </p>
          ) : (
            <div
              ref={listRef}
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
                        id={w.id}
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
                      id={d.id}
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
            className={`h-8 rounded-[8px] px-3.5 text-[13px] ${GLASS_BUTTON}`}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!pickedHere}
            onClick={choose}
            className={`h-8 rounded-[8px] px-4 text-[13px] ${GLASS_PRIMARY}`}
          >
            {confirmLabel(kind)}
          </button>
        </div>
      </div>
    </div>
  );
}
