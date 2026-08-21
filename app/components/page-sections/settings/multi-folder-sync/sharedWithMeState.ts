// Pure view/row routing for `SharedWithMeSection` — the sidebarSearchState
// convention. Unit-tested in `__tests__/sharedWithMeState.test.ts`.

import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";

/** Data lifecycle of the memberships fetch. */
export type SharedWithMeData =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; memberships: DriveMembershipInfo[] }
  | { kind: "unavailable" }
  | { kind: "error" };

export type SharedWithMeView = "hidden" | "rows";

/**
 * Whether the section renders at all. Deliberately binary: most accounts
 * have zero memberships, so every non-rows state — flag off, still
 * loading, empty, feature-off server, or a failed passive fetch — renders
 * NOTHING rather than a headline with a skeleton or an error under it.
 * A section that appears only when there is something to show is the
 * quiet degrade the feature-off rule requires, and it costs a user with
 * memberships at most one frame of absence while the list loads.
 */
export function getSharedWithMeView(enabled: boolean, data: SharedWithMeData): SharedWithMeView {
  if (!enabled) return "hidden";
  switch (data.kind) {
    case "idle":
    case "loading":
    case "unavailable":
    case "error":
      return "hidden";
    case "ready":
      return data.memberships.length === 0 ? "hidden" : "rows";
  }
}

export type MembershipRowAction =
  | { kind: "synced"; localLabel: string }
  | { kind: "sync-locally" };

/**
 * How a membership row's action side renders. `synced` requires BOTH join
 * fields from Rust — a `syncedLocally` without a label (which the backend
 * never produces; `localLabel` is null exactly when unsynced) degrades to
 * offering "Sync locally", whose backend is idempotent per wire identity
 * and would simply repair/name the existing slot.
 */
export function getMembershipRowAction(
  membership: Pick<DriveMembershipInfo, "syncedLocally" | "localLabel">,
): MembershipRowAction {
  if (membership.syncedLocally && membership.localLabel) {
    return { kind: "synced", localLabel: membership.localLabel };
  }
  return { kind: "sync-locally" };
}
