import type { CapacitySource } from "@/app/lib/hooks/api/useStorageOverview";

/**
 * Whether the Drive page should show the plan catalogue under its empty
 * state.
 *
 * Only for an account with nothing at all: no folder synced and no plan.
 * There is no drive to look at yet, and how much room they get is the next
 * thing they have to decide, so the plans are the most useful thing that
 * can occupy the space.
 *
 * Everyone else sees nothing here. An account with folders came to look at
 * them, and one already on a plan has nothing to choose — the header card
 * already states what they are on, and a catalogue under it would read as
 * a page that has not noticed.
 */
export function shouldShowFreshAccountPlans(opts: {
  /** Whether the account has any folder at all, local or remote. */
  hasFolders: boolean;
  /** Which source won the capacity decision, from Rust. */
  source: CapacitySource | undefined;
  /** Whether either the folder list or the plan decision is still loading. */
  isLoading: boolean;
}): boolean {
  // Never flash the catalogue at an account that turns out to have a plan
  // or a folder — an empty first render is not evidence of an empty
  // account, and appearing then vanishing reads as a glitch.
  if (opts.isLoading) return false;
  if (opts.hasFolders) return false;
  // `undefined` is the unsettled/error case: say nothing rather than sell
  // a plan to someone who may already have one.
  return opts.source === "free";
}
