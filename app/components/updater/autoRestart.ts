import type { RestartBlocker } from "@/lib/tauri/updates";

/**
 * How long the "Restarting…" state shows before the app relaunches by itself.
 * Long enough to read, short enough that nobody reaches for a button.
 */
export const AUTO_RESTART_DELAY_MS = 2000;

/** How often "Restart when done" asks Rust whether the work has finished. */
export const RESTART_POLL_MS = 3000;

type WaitDeps = {
  /** Rust's answer: what a restart now would cut off. Empty = restart. */
  getBlockers: () => Promise<RestartBlocker[]>;
  restart: () => Promise<void>;
  /** Told each time the list changes, so a caller can show what it waits for. */
  onBlockers?: (blockers: RestartBlocker[]) => void;
  pollMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait until nothing would be lost, then restart.
 *
 * A failed question to Rust counts as "nothing in the way": the user already
 * chose to restart, and a check that cannot answer must not keep an installed
 * update from ever taking effect.
 */
export async function waitThenRestart({
  getBlockers,
  restart,
  onBlockers,
  pollMs = RESTART_POLL_MS,
  signal,
  sleep = defaultSleep,
}: WaitDeps): Promise<"restarted" | "cancelled"> {
  for (;;) {
    if (signal?.aborted) return "cancelled";
    const blockers = await getBlockers().catch(() => [] as RestartBlocker[]);
    if (signal?.aborted) return "cancelled";
    if (blockers.length === 0) {
      await restart();
      return "restarted";
    }
    onBlockers?.(blockers);
    await sleep(pollMs);
  }
}

/**
 * The one "Restart when done" wait running in this window. Kept outside the
 * dialog so closing the dialog does not stop it; starting another replaces it.
 */
let pending: AbortController | null = null;

export function startRestartWhenDone(
  deps: Omit<WaitDeps, "signal">,
): Promise<"restarted" | "cancelled"> {
  pending?.abort();
  const controller = new AbortController();
  pending = controller;
  return waitThenRestart({ ...deps, signal: controller.signal }).finally(() => {
    if (pending === controller) pending = null;
  });
}

/** Whether a "Restart when done" wait is running. */
export function restartIsPending(): boolean {
  return pending !== null;
}

/** Stop a running "Restart when done" wait. */
export function cancelPendingRestart(): void {
  pending?.abort();
  pending = null;
}
