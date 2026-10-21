// Presentation helpers for the Insights sheet: how numbers read, the words it
// uses, the avatar a name gets, where most people stopped, and the SAMPLE
// numbers a locked part is drawn from. What is locked, what a plan sees and
// the viewers' names are decided in Rust (`shares::insights`).
//
// The web console draws the same sheet, so the words and the avatar palette
// here are the console's too: change them in both places or neither.

import type { InsightsViewer, ShareComment } from "@/app/lib/tauri/shareInsights";

/** What a viewer or commenter without a chosen name is called. */
export const ANONYMOUS = "Anonymous viewer";

/**
 * The upgrade prompt for Insights on the free plan, where the Insights switch
 * is turned on: the same words the web app uses.
 */
export const LOCKED_PROMPT = "Insights are available on paid Drive plans";
export const LOCKED_ACTION = "Upgrade";
/** The line under the prompt where the Insights switch was turned on. */
export const SWITCH_UPGRADE_BODY = "Upgrade to count views and watch time on your links and see who watched.";

/** The free plan's lock over the blurred sample. */
export const LOCK_TITLE = "See who watched and where they stopped";
/** Under the lock while the link is counting views. */
export const LOCK_BODY =
  "Your views are being counted. Completion, the retention chart and the viewer list come with paid Drive plans.";
/** Under the lock while the link's Insights switch is off: nothing is counted. */
export const LOCK_BODY_NOT_COUNTING =
  "Count this link's views and watch time, and see who watched and where they stopped.";
export const UPGRADE_PLAN = "Upgrade plan";
export const COMPARE_PLANS = "Compare plans";
/** Where Compare plans goes: the plans side by side on the website. */
export const PRICING_URL = "https://hippius.com/pricing";

/** The comment menu's lines under each action. */
export const BLOCK_EXPLAINER = "They can no longer comment or react on this link.";
export const DELETE_EXPLAINER = "Removes it for everyone.";

/** Above this many viewers or comments, the sheet splits into tabs. */
export const TABS_THRESHOLD = 10;
/** How many viewers the overview lists before "See all". */
export const OVERVIEW_VIEWERS = 5;
/** How many comments the overview lists when the Comments tab holds the rest. */
export const OVERVIEW_COMMENTS = 3;

/**
 * Whether the sheet splits into Overview, Viewers and Comments tabs: once a
 * link has more than about ten viewers or comments. Below that a single
 * scroll reads better.
 */
export function usesTabs(viewers: number, comments: number): boolean {
  return viewers > TABS_THRESHOLD || comments > TABS_THRESHOLD;
}

/** A length the way a video player shows it: `0:42`, `12:05`, `1:02:03`. */
export function formatWatched(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 0 to 1 as a whole percentage: `0.256` reads `26%`. */
export function formatPercent(fraction: number): string {
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${Math.round(clamped * 100)}%`;
}

/** How long ago, as short as the rows have room for: `now`, `5m`, `2h`, `3d`, then the date. */
export function formatAgo(rfc3339: string, now: number = Date.now()): string {
  const ms = Date.parse(rfc3339);
  if (Number.isNaN(ms)) return "";
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return formatShortDate(rfc3339, now);
}

/** `Oct 20`, with the year when it is not this one. */
export function formatShortDate(rfc3339: string, now: number = Date.now()): string {
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** The header's line: `Shared Oct 20 · 4:12 · link on`, leaving out what is not known. */
export function headerLine({
  sharedAt,
  durationMs,
  expiresAt,
  now = Date.now(),
}: {
  sharedAt: string | null;
  durationMs: number | null;
  /** `undefined` when the link is not known here; `null` when it never expires. */
  expiresAt: string | null | undefined;
  now?: number;
}): string {
  const parts: string[] = [];
  if (sharedAt) {
    const date = formatShortDate(sharedAt, now);
    if (date) parts.push(`Shared ${date}`);
  }
  if (durationMs !== null && durationMs > 0) parts.push(formatWatched(durationMs));
  if (expiresAt !== undefined) {
    const expired = expiresAt !== null && Date.parse(expiresAt) <= now;
    parts.push(expired ? "link expired" : "link on");
  }
  return parts.join(" · ");
}

export function viewerName(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : ANONYMOUS;
}

export function countLabel(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The avatar colours, picked from the name so a person keeps theirs. Fixed,
 * not theme tokens: each carries white initials in both themes.
 */
export const AVATAR_COLORS = ["#E8743B", "#2E9E6B", "#8B5CF6", "#D9486F", "#3167DD", "#0E8FA8"] as const;

/**
 * FNV-1a over the code points of the lowercased name, so a name keeps its
 * colour. The console hashes names exactly this way, so a person gets the
 * same colour in both apps.
 */
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.toLocaleLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** First letter of the first and last word: `Maya Chen` reads `MC`, `Maya` reads `M`. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toLocaleUpperCase();
}

/**
 * A named person's avatar: initials on a colour from the fixed palette.
 * `null` for someone without a name, who gets the neutral avatar.
 */
export function avatarFor(name: string | null): { initials: string; color: string } | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return { initials: initials(trimmed), color: AVATAR_COLORS[nameHash(trimmed) % AVATAR_COLORS.length] };
}

/** Under this many points the steepest slide is not called a drop. */
const MIN_DROP_POINTS = 2;

/**
 * Where most people stopped: the steepest slide of the retention curve.
 * Over a window of about 3% of the recording (so one drop split across two
 * buckets still counts as one), the place the curve falls furthest; inside
 * it, the single steepest step. `at` is that moment as a fraction of the
 * recording (0 to 1), `drop` the percentage points lost over the window.
 * `null` with too little data or no real drop.
 */
export function biggestDrop(retention: readonly number[]): { at: number; drop: number } | null {
  const n = retention.length;
  if (n < 2) return null;
  const window = Math.max(1, Math.round(n * 0.03));
  let best = 0;
  let start = -1;
  for (let i = 0; i + window < n; i++) {
    const d = retention[i] - retention[i + window];
    if (d > best) {
      best = d;
      start = i;
    }
  }
  if (start < 0 || best < MIN_DROP_POINTS) return null;
  let step = start;
  let stepDrop = -Infinity;
  for (let j = start; j < start + window; j++) {
    const d = retention[j] - retention[j + 1];
    if (d > stepDrop) {
      stepDrop = d;
      step = j;
    }
  }
  return { at: (step + 1) / (n - 1), drop: best };
}

/** A moment in the recording: `2:05` when its length is known, else how far in. */
export function formatMomentAt(fraction: number, durationMs: number | null): string {
  return durationMs !== null && durationMs > 0 ? formatWatched(fraction * durationMs) : `${formatPercent(fraction)} in`;
}

/**
 * The recording's length, worked out from what Insights has: the server
 * sends no length, but a viewer who came once covered `completion` of it in
 * `watchedMs`, which pins it exactly (up to rounding). The viewer who saw the
 * most of it gives the best reading. A comment cannot sit past the end, so
 * the latest one is a floor. `null` when no single visit says.
 */
export function estimateDurationMs(
  viewers: readonly InsightsViewer[],
  comments: readonly Pick<ShareComment, "atMs">[] = [],
): number | null {
  let best: InsightsViewer | null = null;
  for (const v of viewers) {
    if (v.visits !== 1 || v.completion === null || v.completion < 0.2 || v.watchedMs <= 0) continue;
    if (!best || (v.completion ?? 0) > (best.completion ?? 0)) best = v;
  }
  if (!best || best.completion === null) return null;
  const fromViewer = best.watchedMs / best.completion;
  const latestComment = comments.reduce((m, c) => (c.atMs !== null && c.atMs > m ? c.atMs : m), 0);
  return Math.round(Math.max(fromViewer, latestComment) / 1000) * 1000;
}

/**
 * Average watch per visit: everything watched over every view. `null` for a
 * link with no video visit to measure (a picture, or no views yet).
 */
export function averageWatchMs(viewers: readonly InsightsViewer[], totalViews: number): number | null {
  if (totalViews <= 0 || !viewers.some((v) => v.completion !== null)) return null;
  const watched = viewers.reduce((sum, v) => sum + Math.max(0, v.watchedMs), 0);
  return watched / totalViews;
}

/** The retention value at a fraction of the recording, read off the nearest point. */
export function retentionAt(retention: readonly number[], fraction: number): number {
  if (retention.length === 0) return 0;
  const i = Math.round(Math.min(1, Math.max(0, fraction)) * (retention.length - 1));
  return Math.min(100, Math.max(0, retention[i]));
}

/**
 * SAMPLE numbers for the locked part. They are made up and drawn blurred
 * behind the lock so a free plan sees the shape of what it would get; no real
 * value ever reaches a locked part (Rust sends none).
 */
/** Sample counts for a free link that is not counting views. */
export const SAMPLE_VIEWS = 24;
export const SAMPLE_UNIQUE_VIEWERS = 9;
export const SAMPLE_COMPLETION = 0.68;
export const SAMPLE_AVERAGE_WATCH_MS = 171_000;

export const SAMPLE_RETENTION: number[] = Array.from({ length: 100 }, (_, i) =>
  Math.round(100 - i * 0.45 - (i > 48 ? 12 : 0) - (i > 70 ? (i - 70) * 0.9 : 0)),
);

export const SAMPLE_VIEWERS: InsightsViewer[] = [
  { viewerId: "sample-1", name: "Sample viewer", visits: 2, watchedMs: 102_000, completion: 0.92, lastViewedAt: null, comments: 1, reactions: 0 },
  { viewerId: "sample-2", name: null, visits: 1, watchedMs: 47_000, completion: 0.41, lastViewedAt: null, comments: 0, reactions: 1 },
];

/** "How we count views": what each number means. */
export const DEFINITIONS: ReadonlyArray<{ term: string; meaning: string }> = [
  { term: "Views", meaning: "Each time the link is opened." },
  {
    term: "Unique viewers",
    meaning: "Different browsers that opened it. The same person on two devices counts twice.",
  },
  {
    term: "Completion",
    meaning: "How much of the recording each visit watched, on average. Parts watched twice count once.",
  },
  { term: "Average watch", meaning: "Time watched, over every view." },
  {
    term: "Where people stopped",
    meaning: "For each moment of the recording, how many visits reached it.",
  },
  { term: "Pictures", meaning: "Screenshots and other pictures have views and viewers, but no completion or retention." },
  {
    term: "Privacy",
    meaning: "Viewers stay anonymous unless they comment under a name. Only numbers are kept, never what they saw.",
  },
];
