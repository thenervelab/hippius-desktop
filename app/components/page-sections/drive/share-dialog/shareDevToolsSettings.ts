// What the Share dev tools panel (`ShareDevTools.tsx`) has set: whether the
// Share dialog and the Manage access panel draw fake preview data, how much
// of it, and how the fake server behaves. Dev and staging builds only.
//
// Stored per machine in localStorage under `SHARE_DEVTOOLS_KEY` as JSON. The
// older key `hippius:share-dialog-fixture` ("12", "12 locked") still works:
// when the new key is absent it turns fake data on with that many people.
// Every read and write is wrapped, so blocked storage reads as "off".
//
// Pure apart from the storage and the window event, so the gate, the presets
// and the clamping are tested without a render.

import { useEffect } from "react";
import { enabledFrom } from "@/app/lib/buildChannel";

/** Dev and staging builds only; false at build time on beta and production. */
export const SHARE_FIXTURE_AVAILABLE =
  enabledFrom("staging") || process.env.NODE_ENV === "development";

export const SHARE_DEVTOOLS_KEY = "hippius:share-devtools";
/** The older, single-number switch. Maps to People. */
export const SHARE_FIXTURE_KEY = "hippius:share-dialog-fixture";
/** Fired on `window` after the settings change, so open surfaces reload. */
export const SHARE_DEVTOOLS_EVENT = "hippius:share-devtools-changed";

export const LATENCY_STEPS = [0, 1200, 3000] as const;
export const FAILURE_STEPS = [0, 33, 100] as const;
export type LatencyMs = (typeof LATENCY_STEPS)[number];
export type FailureRate = (typeof FAILURE_STEPS)[number];

export const LIMITS = {
  people: 100,
  pending: 50,
  activeLinks: 100,
  endedLinks: 50,
} as const;

export interface ShareDevSettings {
  /** Draw fake data instead of calling the real commands. */
  enabled: boolean;
  /** People besides the owner: members, plus a few folder holders. */
  people: number;
  /** Emailed invitations still waiting. */
  pending: number;
  /** Links that still work. */
  activeLinks: number;
  /** Links that expired, were used up or were revoked. */
  endedLinks: number;
  linksLocked: boolean;
  /** Hold every listing on its skeleton. */
  loading: boolean;
  /** Every listing fails to load. */
  error: boolean;
  /** How long every fake answer takes. */
  latencyMs: LatencyMs;
  /** Share of role changes, removals, cancels, revokes and approvals refused. */
  failureRate: FailureRate;
}

export const DEFAULT_SETTINGS: ShareDevSettings = {
  enabled: false,
  people: 12,
  pending: 4,
  activeLinks: 3,
  endedLinks: 2,
  linksLocked: false,
  loading: false,
  error: false,
  latencyMs: 0,
  failureRate: 0,
};

export type PresetId = "empty" | "small" | "big" | "huge";

export const PRESETS: ReadonlyArray<{
  id: PresetId;
  label: string;
  counts: Pick<ShareDevSettings, "people" | "pending" | "activeLinks" | "endedLinks">;
}> = [
  { id: "empty", label: "Empty", counts: { people: 0, pending: 0, activeLinks: 0, endedLinks: 0 } },
  { id: "small", label: "Small team (5)", counts: { people: 5, pending: 1, activeLinks: 2, endedLinks: 1 } },
  {
    id: "big",
    label: "Big drive (60 people, 45 links, 15 expired)",
    counts: { people: 60, pending: 6, activeLinks: 45, endedLinks: 15 },
  },
  { id: "huge", label: "Huge (100/100/50)", counts: { people: 100, pending: 50, activeLinks: 100, endedLinks: 50 } },
];

/** A preset switches fake data on and clears the Loading and Error holds. */
export function applyPreset(current: ShareDevSettings, id: PresetId): ShareDevSettings {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return current;
  return { ...current, ...preset.counts, enabled: true, loading: false, error: false };
}

function clampInt(value: unknown, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(n)));
}

function oneOf<T extends number>(steps: readonly T[], value: unknown, fallback: T): T {
  return steps.includes(value as T) ? (value as T) : fallback;
}

/** Settings from whatever is stored, every field checked and clamped. */
export function normalizeSettings(raw: unknown): ShareDevSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  return {
    enabled: o.enabled === true,
    people: clampInt(o.people, LIMITS.people, d.people),
    pending: clampInt(o.pending, LIMITS.pending, d.pending),
    activeLinks: clampInt(o.activeLinks, LIMITS.activeLinks, d.activeLinks),
    endedLinks: clampInt(o.endedLinks, LIMITS.endedLinks, d.endedLinks),
    linksLocked: o.linksLocked === true,
    loading: o.loading === true,
    error: o.error === true,
    latencyMs: oneOf(LATENCY_STEPS, o.latencyMs, d.latencyMs),
    failureRate: oneOf(FAILURE_STEPS, o.failureRate, d.failureRate),
  };
}

/** The older key: "12" or "12 locked" means fake data on, with 12 people. */
export function settingsFromLegacy(raw: string | null): ShareDevSettings | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    people: clampInt(n, LIMITS.people, 0),
    linksLocked: raw.includes("locked"),
  };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * What the panel shows: the stored settings, or the defaults (fake data off).
 * Nothing at all on a build that does not allow the tools.
 */
export function readShareDevSettings(
  available: boolean = SHARE_FIXTURE_AVAILABLE,
  storage: Storage | null = browserStorage(),
): ShareDevSettings {
  if (!available || !storage) return DEFAULT_SETTINGS;
  try {
    const stored = storage.getItem(SHARE_DEVTOOLS_KEY);
    if (stored !== null) return normalizeSettings(JSON.parse(stored));
    return settingsFromLegacy(storage.getItem(SHARE_FIXTURE_KEY)) ?? DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * The settings a Share dialog or panel should draw with, or null for the
 * real commands. Always null on beta and production.
 */
export function activeShareDevSettings(
  available: boolean = SHARE_FIXTURE_AVAILABLE,
  storage: Storage | null = browserStorage(),
): ShareDevSettings | null {
  if (!available) return null;
  const s = readShareDevSettings(available, storage);
  return s.enabled ? s : null;
}

/** Store the settings and tell open surfaces. A refused write is ignored. */
export function writeShareDevSettings(
  settings: ShareDevSettings,
  available: boolean = SHARE_FIXTURE_AVAILABLE,
  storage: Storage | null = browserStorage(),
): void {
  if (!available || !storage) return;
  try {
    storage.setItem(SHARE_DEVTOOLS_KEY, JSON.stringify(normalizeSettings(settings)));
    // The new key wins from now on; the old one would only confuse a reader.
    storage.removeItem(SHARE_FIXTURE_KEY);
  } catch {
    // Blocked storage: the change lasts until the next read, which is fine
    // for a preview aid.
  }
  notifyShareDevSettingsChanged();
}

/** Forget everything: back to real data. */
export function resetShareDevSettings(
  available: boolean = SHARE_FIXTURE_AVAILABLE,
  storage: Storage | null = browserStorage(),
): void {
  if (!available || !storage) return;
  try {
    storage.removeItem(SHARE_DEVTOOLS_KEY);
    storage.removeItem(SHARE_FIXTURE_KEY);
  } catch {
    // As above.
  }
  notifyShareDevSettingsChanged();
}

export function notifyShareDevSettingsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SHARE_DEVTOOLS_EVENT));
}

/** Call `onChange` after every settings change; returns the unsubscribe. */
export function subscribeShareDevSettings(onChange: () => void): () => void {
  if (!SHARE_FIXTURE_AVAILABLE || typeof window === "undefined") return () => {};
  window.addEventListener(SHARE_DEVTOOLS_EVENT, onChange);
  return () => window.removeEventListener(SHARE_DEVTOOLS_EVENT, onChange);
}

/**
 * Start a surface over from its skeleton whenever the dev tools change, so a
 * Share dialog or panel already open follows them. Does nothing on a build
 * without the tools.
 */
export function useReloadOnShareDevToolsChange(restart: () => void): void {
  useEffect(() => subscribeShareDevSettings(restart), [restart]);
}
