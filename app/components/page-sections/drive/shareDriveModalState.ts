// Pure state resolvers for `ShareDriveModal` — the sidebarSearchState
// convention: the component stays declarative and the view routing is
// unit-testable without a render. Tested in
// `__tests__/shareDriveModalState.test.ts`.

import type { DriveMemberInfo } from "@/app/lib/tauri/sharedDrives";

/**
 * Invite-tab lifecycle. Mirrors `ShareFileModal`'s machine minus progress
 * (an invite mint is one short HTTP call, not an upload), plus the
 * `unavailable` terminal for a feature-off server — a degrade, not an
 * error, so it gets its own quiet copy and no retry button.
 */
export type InviteState =
  | { kind: "choosing" }
  | { kind: "running" }
  | { kind: "done"; inviteUrl: string }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

/**
 * Members-tab data lifecycle. `idle` means the tab has never been opened
 * this session — the fetch is lazy so minting an invite costs no member
 * listing round-trip.
 */
export type MembersState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; members: DriveMemberInfo[] }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export type MembersView = "loading" | "rows" | "empty" | "unavailable" | "error";

/**
 * Which members-tab body renders. `idle` maps to `loading` — by the time
 * anything is on screen the activation effect has started the fetch, and
 * rendering a skeleton for the one frame in between beats a flash of the
 * empty state.
 */
export function getMembersView(state: MembersState): MembersView {
  switch (state.kind) {
    case "idle":
    case "loading":
      return "loading";
    case "ready":
      return state.members.length === 0 ? "empty" : "rows";
    case "unavailable":
      return "unavailable";
    case "error":
      return "error";
  }
}

/**
 * Invite lifetimes offered by the expiry row. No "never" — an unclaimed
 * invite link is a standing drive-access capability, so every preset
 * expires; the default matches the backend wrapper's
 * `DEFAULT_INVITE_TTL_SECS` (7 days).
 */
export const INVITE_TTL_OPTIONS: ReadonlyArray<{ label: string; secs: number }> = [
  { label: "24 hours", secs: 24 * 60 * 60 },
  { label: "7 days", secs: 7 * 24 * 60 * 60 },
  { label: "30 days", secs: 30 * 24 * 60 * 60 },
];

/**
 * "Joined Aug 20, 2026" — fixed en-US like the folder rows' date column,
 * so tests don't depend on the runner's locale. `null` for an unparseable
 * timestamp: the row then omits the line instead of showing
 * "Invalid Date".
 */
export function formatJoinedDate(rfc3339: string): string | null {
  const ts = Date.parse(rfc3339);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()}, ${d.getFullYear()}`;
}
