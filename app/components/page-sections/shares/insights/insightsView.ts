// Presentation helpers for the Insights sheet: how numbers read, and the
// SAMPLE numbers a locked card is drawn from. What is locked, what a plan
// sees and the viewers' names are decided in Rust (`shares::insights`).

import type { InsightsViewer } from "@/app/lib/tauri/shareInsights";

/** What a viewer without a chosen name is called. */
export const SOMEONE = "Someone";

/**
 * The upgrade prompt for Insights on the free plan: the sheet's locked state
 * and the Insights switch use the same words, as the web app does.
 */
export const LOCKED_PROMPT = "Insights are available on paid Drive plans";
export const LOCKED_ACTION = "Upgrade";
/** The sheet's line under the prompt: what upgrading gives this link. */
export const LOCKED_BODY = "Count this link's views and watch time, and see who watched and where they stopped.";
/** The line under the prompt where the Insights switch was turned on. */
export const SWITCH_UPGRADE_BODY = "Upgrade to count views and watch time on your links and see who watched.";

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

/** A moment in a recording, for a comment tied to one: `at 1:23`. */
export function formatMoment(ms: number): string {
  return `at ${formatWatched(ms)}`;
}

export function viewerName(name: string | null): string {
  return name ?? SOMEONE;
}

/** One line about a viewer: what they watched and how often they came. */
export function viewerSummary(v: InsightsViewer): string {
  const parts: string[] = [];
  if (v.completion !== null) parts.push(`Watched ${formatWatched(v.watchedMs)} (${formatPercent(v.completion)})`);
  parts.push(v.visits === 1 ? "1 visit" : `${v.visits} visits`);
  if (v.comments > 0) parts.push(v.comments === 1 ? "1 comment" : `${v.comments} comments`);
  return parts.join(" · ");
}

/**
 * SAMPLE numbers for the locked cards. They are made up and drawn blurred
 * behind the upgrade prompt so a free plan sees the shape of what it would
 * get; no real value ever reaches a locked card (Rust sends none).
 */
/** Sample counts for a free link that is not counting views. */
export const SAMPLE_VIEWS = 24;
export const SAMPLE_UNIQUE_VIEWERS = 9;
export const SAMPLE_COMPLETION = 0.68;

export const SAMPLE_RETENTION: number[] = Array.from({ length: 100 }, (_, i) =>
  Math.round(100 - i * 0.45 - (i > 70 ? (i - 70) * 0.9 : 0)),
);

export const SAMPLE_VIEWERS: InsightsViewer[] = [
  { viewerId: "sample-1", name: "Sample viewer", visits: 2, watchedMs: 102_000, completion: 0.92, lastViewedAt: null, comments: 1, reactions: 0 },
  { viewerId: "sample-2", name: null, visits: 1, watchedMs: 47_000, completion: 0.41, lastViewedAt: null, comments: 0, reactions: 1 },
  { viewerId: "sample-3", name: null, visits: 1, watchedMs: 18_000, completion: 0.16, lastViewedAt: null, comments: 0, reactions: 0 },
];

/** "See how we calculate this": what each number means. */
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
  {
    term: "Retention",
    meaning: "For each moment of the recording, how many visits reached it.",
  },
  { term: "Pictures", meaning: "Screenshots and other pictures have views and viewers, but no completion or retention." },
  {
    term: "Privacy",
    meaning: "Viewers stay anonymous unless they comment under a name. Only numbers are kept, never what they saw.",
  },
];
