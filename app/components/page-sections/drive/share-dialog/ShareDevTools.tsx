"use client";

// Share dev tools: a small floating panel, dev and staging builds only, that
// fills the Share dialog and the Manage access panel with fake people,
// invitations and links, so they can be looked at with a big drive.
//
// How to use it (in `pnpm tauri:dev` or a staging build):
//
//   1. Click the "Share dev tools" pill at the bottom left of the window, or
//      press Ctrl+Shift+D (Cmd+Shift+D on a Mac). Escape, or the same
//      shortcut, folds it back into the pill.
//   2. Turn on "Enable fake data", or pick a preset: Empty, Small team (5),
//      Big drive (60 people, 45 links, 15 expired), Huge (100/100/50).
//   3. Open Share, or Manage access, on any drive or folder you own. Every
//      change here applies live: an open dialog or panel reloads.
//
// Loading holds the skeletons, Error fails the load, Slow network delays
// every fake answer, and Failure rate refuses that share of role changes,
// removals, cancels, revokes and approvals, so the "Saving…" states and the
// inline errors can be seen. Reset forgets it all and goes back to real data.
//
// Never on beta or production: `SHARE_FIXTURE_AVAILABLE` is false at build
// time there, so nothing renders and no listener is installed.
//
// It sits above the Share dialog and the side panel and stays usable while
// they are open. Those are Radix modals: they turn off pointer events on
// <body>, pull focus back inside themselves, close on a pointer-down outside
// and block wheel scrolling outside. Each of those is a listener on
// `document`, so a capture listener on `window` stops the events that start
// inside this panel before they get there (see `useIsolateFromModals`).
// Because of that, this panel uses no React focus, pointer or key handlers;
// clicks and native input behaviour are untouched.

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FlaskConical } from "lucide-react";

import { useAppTheme } from "@/app/lib/theme-context";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SETTINGS,
  FAILURE_STEPS,
  LATENCY_STEPS,
  LIMITS,
  PRESETS,
  SHARE_FIXTURE_AVAILABLE,
  applyPreset,
  readShareDevSettings,
  resetShareDevSettings,
  subscribeShareDevSettings,
  writeShareDevSettings,
  type ShareDevSettings,
} from "./shareDevToolsSettings";

const OPEN_KEY = "hippius:share-devtools-open";
/** Sliders write after the hand stops, so the dialog does not reload per step. */
const WRITE_DELAY_MS = 250;
/** Above every dialog and side panel in the app. */
const Z_INDEX = 2_147_483_000;

export default function ShareDevTools() {
  if (!SHARE_FIXTURE_AVAILABLE) return null;
  return <ShareDevToolsPanel />;
}

/** Whether a Ctrl+Shift+D (or Cmd+Shift+D) keydown is the panel's shortcut. */
export function isShareDevToolsShortcut(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code">): boolean {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyD";
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    if (open) window.localStorage.setItem(OPEN_KEY, "1");
    else window.localStorage.removeItem(OPEN_KEY);
  } catch {
    // Remembering the fold is a convenience only.
  }
}

/**
 * Keep an open Radix modal from swallowing this panel: stop, at the window's
 * capture phase, the events that start in the panel (or, for focusout, that
 * move focus into it) before the modal's document listeners see them. Also
 * owns the keyboard: the shortcut anywhere, Escape inside.
 */
function useIsolateFromModals(
  root: React.RefObject<HTMLDivElement | null>,
  onShortcut: () => void,
  onEscape: () => void,
) {
  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && Boolean(root.current?.contains(t));
    const onKey = (e: KeyboardEvent) => {
      if (isShareDevToolsShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        onShortcut();
        return;
      }
      if (!inside(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
      }
      e.stopPropagation();
    };
    const guard = (e: Event) => {
      if (inside(e.target)) e.stopPropagation();
    };
    const guardFocus = (e: FocusEvent) => {
      if (inside(e.target) || inside(e.relatedTarget)) e.stopPropagation();
    };
    const pointerish = ["pointerdown", "mousedown", "touchstart", "touchmove", "wheel"] as const;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focusin", guardFocus, true);
    window.addEventListener("focusout", guardFocus, true);
    pointerish.forEach((t) => window.addEventListener(t, guard, true));
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focusin", guardFocus, true);
      window.removeEventListener("focusout", guardFocus, true);
      pointerish.forEach((t) => window.removeEventListener(t, guard, true));
    };
  }, [root, onShortcut, onEscape]);
}

function ShareDevToolsPanel() {
  const { resolvedTheme } = useAppTheme();
  const dark = resolvedTheme === "dark";
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ShareDevSettings>(DEFAULT_SETTINGS);
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingWrite = useRef<{ timer: ReturnType<typeof setTimeout>; next: ShareDevSettings } | null>(null);
  const panelId = useId();

  useEffect(() => {
    setMounted(true);
    setSettings(readShareDevSettings());
    setOpen(readOpen());
    // Another window (or the console) changed them: follow.
    return subscribeShareDevSettings(() => {
      if (!pendingWrite.current) setSettings(readShareDevSettings());
    });
  }, []);

  const flush = useCallback(() => {
    const p = pendingWrite.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingWrite.current = null;
    writeShareDevSettings(p.next);
  }, []);
  useEffect(() => flush, [flush]);

  const update = useCallback(
    (next: ShareDevSettings, debounce = false) => {
      setSettings(next);
      if (pendingWrite.current) clearTimeout(pendingWrite.current.timer);
      if (!debounce) {
        pendingWrite.current = null;
        writeShareDevSettings(next);
        return;
      }
      pendingWrite.current = { next, timer: setTimeout(flush, WRITE_DELAY_MS) };
    },
    [flush],
  );

  const setFolded = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    writeOpen(nextOpen);
  }, []);
  const toggle = useCallback(() => setFolded(!open), [open, setFolded]);
  const fold = useCallback(() => setFolded(false), [setFolded]);
  useIsolateFromModals(root, toggle, fold);

  // Focus follows the fold: into the panel as it opens, back to the pill as
  // it closes (only when focus was in the panel, so a shortcut pressed while
  // typing elsewhere does not steal it).
  const wasOpen = useRef(open);
  useEffect(() => {
    if (!mounted || wasOpen.current === open) return;
    wasOpen.current = open;
    if (open) heading.current?.focus();
    else if (root.current?.contains(document.activeElement) || document.activeElement === document.body) {
      pill.current?.focus();
    }
  }, [open, mounted]);

  if (!mounted) return null;

  const t = dark
    ? {
        card: "border-white/10 bg-[#161616] text-white shadow-[0_12px_40px_rgba(0,0,0,0.6)]",
        muted: "text-white/60",
        line: "border-white/10",
        chip: "border-white/15 bg-white/5 hover:bg-white/10",
        chipOn: "border-[#5b8def] bg-[#5b8def]/20 text-white",
        input: "border-white/15 bg-black/40 text-white",
        pill: "border-white/15 bg-[#161616] text-white hover:bg-[#222]",
        focus: "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#5b8def]",
      }
    : {
        card: "border-grey-80 bg-white text-grey-10 shadow-[0_12px_40px_rgba(15,23,42,0.18)]",
        muted: "text-grey-50",
        line: "border-grey-80",
        chip: "border-grey-80 bg-grey-100 hover:bg-grey-90",
        chipOn: "border-primary-50 bg-primary-50/10 text-primary-50",
        input: "border-grey-80 bg-white text-grey-10",
        pill: "border-grey-80 bg-white text-grey-10 hover:bg-grey-90",
        focus: "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-50",
      };

  const set = <K extends keyof ShareDevSettings>(key: K, value: ShareDevSettings[K], debounce = false) =>
    update({ ...settings, [key]: value }, debounce);
  const summary = settings.enabled
    ? `Fake data: ${settings.people} people, ${settings.activeLinks} links, ${settings.endedLinks} ended`
    : "Showing real data";

  return createPortal(
    <div
      ref={root}
      data-share-devtools=""
      // Radix sets pointer-events: none on <body> while a modal is open.
      style={{ pointerEvents: "auto", zIndex: Z_INDEX }}
      className="fixed bottom-4 left-4 font-geist text-[13px]"
    >
      {open ? (
        <section
          id={panelId}
          role="region"
          aria-labelledby={`${panelId}-title`}
          className={cn(
            "flex max-h-[calc(100dvh-32px)] w-[min(300px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border",
            t.card,
          )}
        >
          <header className={cn("flex items-start gap-2 border-b px-3 py-2.5", t.line)}>
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 ref={heading} id={`${panelId}-title`} tabIndex={-1} className="text-[13px] font-semibold outline-none">
                Share dev tools
              </h2>
              <p className={cn("truncate text-xs", t.muted)} aria-live="polite">
                {summary}
              </p>
            </div>
            <button
              type="button"
              aria-label="Fold Share dev tools"
              aria-expanded
              aria-controls={panelId}
              onClick={fold}
              className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", t.chip, t.focus)}
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            <label className="flex cursor-pointer items-center justify-between gap-3 font-medium">
              Enable fake data
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
                className={cn("size-4 accent-primary-50", t.focus)}
              />
            </label>

            <div>
              <p className={cn("mb-1.5 text-xs font-medium", t.muted)}>Presets</p>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => update(applyPreset(settings, p.id))}
                    className={cn("rounded-md border px-2 py-1 text-left text-xs", t.chip, t.focus)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <fieldset disabled={!settings.enabled} className="space-y-3 disabled:opacity-50">
              <legend className="sr-only">Fake data</legend>
              <CountControl
                label="People"
                value={settings.people}
                max={LIMITS.people}
                inputClass={cn(t.input, t.focus)}
                onChange={(v, slide) => set("people", v, slide)}
              />
              <CountControl
                label="Pending invites"
                value={settings.pending}
                max={LIMITS.pending}
                inputClass={cn(t.input, t.focus)}
                onChange={(v, slide) => set("pending", v, slide)}
              />
              <CountControl
                label="Active links"
                value={settings.activeLinks}
                max={LIMITS.activeLinks}
                inputClass={cn(t.input, t.focus)}
                onChange={(v, slide) => set("activeLinks", v, slide)}
              />
              <CountControl
                label="Expired or revoked links"
                value={settings.endedLinks}
                max={LIMITS.endedLinks}
                inputClass={cn(t.input, t.focus)}
                onChange={(v, slide) => set("endedLinks", v, slide)}
              />

              <div className={cn("space-y-1.5 border-t pt-3", t.line)}>
                <Toggle label="Links locked" checked={settings.linksLocked} onChange={(v) => set("linksLocked", v)} focus={t.focus} />
                <Toggle label="Loading (hold skeletons)" checked={settings.loading} onChange={(v) => set("loading", v)} focus={t.focus} />
                <Toggle label="Error (load fails)" checked={settings.error} onChange={(v) => set("error", v)} focus={t.focus} />
              </div>

              <Steps
                label="Slow network"
                value={settings.latencyMs}
                steps={LATENCY_STEPS}
                word={(ms) => (ms === 0 ? "Off" : `${ms / 1000} s`)}
                onChange={(v) => set("latencyMs", v)}
                chip={cn(t.chip, t.focus)}
                chipOn={t.chipOn}
              />
              <Steps
                label="Failure rate"
                value={settings.failureRate}
                steps={FAILURE_STEPS}
                word={(p) => `${p}%`}
                onChange={(v) => set("failureRate", v)}
                chip={cn(t.chip, t.focus)}
                chipOn={t.chipOn}
              />
            </fieldset>
          </div>

          <footer className={cn("flex items-center justify-between gap-2 border-t px-3 py-2", t.line)}>
            <span className={cn("text-xs", t.muted)}>
              <kbd className="font-mono">Ctrl+Shift+D</kbd> to fold
            </span>
            <button
              type="button"
              onClick={() => {
                if (pendingWrite.current) clearTimeout(pendingWrite.current.timer);
                pendingWrite.current = null;
                resetShareDevSettings();
                setSettings(DEFAULT_SETTINGS);
              }}
              className={cn("rounded-md border px-2.5 py-1 text-xs font-medium", t.chip, t.focus)}
            >
              Reset
            </button>
          </footer>
        </section>
      ) : (
        <button
          ref={pill}
          type="button"
          aria-expanded={false}
          aria-keyshortcuts="Control+Shift+D Meta+Shift+D"
          onClick={() => setFolded(true)}
          className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-sm", t.pill, t.focus)}
        >
          <FlaskConical className="size-3.5" aria-hidden />
          Share dev tools
          {settings.enabled ? (
            <span aria-label="fake data on" className="size-1.5 rounded-full bg-[#f5a524]" />
          ) : null}
        </button>
      )}
    </div>,
    document.body,
  );
}

function CountControl({
  label,
  value,
  max,
  inputClass,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  inputClass: string;
  /** `slide` is true for the slider, whose writes wait for the hand to stop. */
  onChange: (value: number, slide: boolean) => void;
}) {
  const id = useId();
  const clamp = (n: number) => Math.max(0, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : 0));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={id} className="min-w-0 truncate">
          {label}
        </label>
        <input
          type="number"
          min={0}
          max={max}
          value={value}
          aria-label={`${label}, number`}
          onChange={(e) => onChange(clamp(e.target.valueAsNumber), true)}
          className={cn("h-6 w-14 shrink-0 rounded-md border px-1.5 text-right text-xs tabular-nums", inputClass)}
        />
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clamp(e.target.valueAsNumber), true)}
        className="h-4 w-full accent-primary-50"
      />
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  focus,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  focus: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={cn("size-4 accent-primary-50", focus)}
      />
    </label>
  );
}

function Steps<T extends number>({
  label,
  value,
  steps,
  word,
  onChange,
  chip,
  chipOn,
}: {
  label: string;
  value: T;
  steps: readonly T[];
  word: (v: T) => string;
  onChange: (v: T) => void;
  chip: string;
  chipOn: string;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1.5">{label}</legend>
      <div className="flex gap-1.5">
        {steps.map((s) => (
          // A native radio group: arrow keys move between the steps.
          <label
            key={s}
            className={cn(
              "flex-1 cursor-pointer rounded-md border px-2 py-1 text-center text-xs has-[:focus-visible]:outline has-[:focus-visible]:outline-2",
              chip,
              value === s && chipOn,
            )}
          >
            <input
              type="radio"
              name={name}
              value={s}
              checked={value === s}
              onChange={() => onChange(s)}
              className="sr-only"
            />
            {word(s)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
