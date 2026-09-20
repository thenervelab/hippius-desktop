/**
 * Presence for the people in the sidebar and the member panel.
 *
 * Simplified sliding sync (MSC4186) has no presence extension, so presence
 * does not arrive with the sync stream. Instead the users we actually
 * display are polled through `GET /presence/{userId}/status` on a slow
 * cadence and cached here; `PresenceTracker` is a tiny emitter the React
 * layer subscribes to.
 */

import type { MatrixClient } from "matrix-js-sdk";

export type PresenceState = "online" | "offline" | "unavailable" | "unknown";

export interface PresenceInfo {
  state: PresenceState;
  /** Milliseconds since the user was last active, when the server says. */
  lastActiveAgo: number | null;
  statusMsg: string | null;
}

export const UNKNOWN_PRESENCE: PresenceInfo = { state: "unknown", lastActiveAgo: null, statusMsg: null };

/** How often a tracked user is re-polled. */
export const PRESENCE_POLL_INTERVAL_MS = 60_000;
/** Cap on parallel presence requests per tick. */
const PRESENCE_BATCH = 8;

type Listener = () => void;

export class PresenceTracker {
  private readonly cache = new Map<string, PresenceInfo>();
  private readonly tracked = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  private readonly client: MatrixClient;

  constructor(client: MatrixClient) {
    this.client = client;
  }

  get(userId: string): PresenceInfo {
    // Prefer anything the SDK already knows (e.g. from a classic sync).
    const user = this.client.getUser(userId);
    if (user?.presence && user.presence !== "unknown" && !this.cache.has(userId)) {
      return {
        state: user.presence as PresenceState,
        lastActiveAgo: user.lastActiveAgo ?? null,
        statusMsg: user.presenceStatusMsg ?? null,
      };
    }
    return this.cache.get(userId) ?? UNKNOWN_PRESENCE;
  }

  /** Reference-counted: a user is polled while at least one view shows them. */
  track(userIds: Iterable<string>): () => void {
    const ids = [...userIds];
    for (const id of ids) this.tracked.set(id, (this.tracked.get(id) ?? 0) + 1);
    this.ensureTimer();
    void this.poll(ids.filter((id) => !this.cache.has(id)));
    return () => {
      for (const id of ids) {
        const n = (this.tracked.get(id) ?? 1) - 1;
        if (n <= 0) this.tracked.delete(id);
        else this.tracked.set(id, n);
      }
      if (this.tracked.size === 0) this.stopTimer();
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.stopTimer();
    this.listeners.clear();
    this.tracked.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll([...this.tracked.keys()]);
    }, PRESENCE_POLL_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(userIds: string[]): Promise<void> {
    if (this.inFlight || userIds.length === 0) return;
    this.inFlight = true;
    let changed = false;
    try {
      for (let i = 0; i < userIds.length; i += PRESENCE_BATCH) {
        const slice = userIds.slice(i, i + PRESENCE_BATCH);
        const results = await Promise.allSettled(slice.map((id) => this.client.getPresence(id)));
        results.forEach((result, index) => {
          const userId = slice[index];
          const next: PresenceInfo =
            result.status === "fulfilled"
              ? {
                  state: (result.value.presence as PresenceState) ?? "unknown",
                  lastActiveAgo: result.value.last_active_ago ?? null,
                  statusMsg: result.value.status_msg ?? null,
                }
              : // Servers may forbid reading presence of strangers: stay unknown.
                UNKNOWN_PRESENCE;
          const previous = this.cache.get(userId);
          if (!previous || previous.state !== next.state || previous.statusMsg !== next.statusMsg) {
            changed = true;
          }
          this.cache.set(userId, next);
        });
      }
    } finally {
      this.inFlight = false;
    }
    if (changed) for (const listener of this.listeners) listener();
  }
}

/** Human label for a presence state, Slack-style. */
export function presenceLabel(info: PresenceInfo): string {
  switch (info.state) {
    case "online":
      return "Active";
    case "unavailable":
      return "Away";
    case "offline":
      return "Away";
    default:
      return "Status unknown";
  }
}
