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
  // The mint plan gate: the owner's plan does not include shared drives. A
  // terminal upgrade state, not an error — its own copy and CTA, no retry.
  | { kind: "notEntitled" }
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
 * "Never expires", expressed as the hcfs server's 100-year lifetime cap —
 * the server keeps `expires_at` a plain timestamp, and clients that want a
 * non-expiring invite send exactly the cap value
 * (`hcfs-server/handlers/drive_invites.rs::MAX_EXPIRES_SECS`). Teams asked
 * for standing invite links (2026-08-24), superseding the v1 "every preset
 * expires" stance; access is still revocable per member from the Members
 * tab.
 */
export const NEVER_EXPIRES_SECS = 100 * 365 * 24 * 60 * 60;

/** Invite lifetimes offered by the expiry row. */
export const INVITE_TTL_OPTIONS: ReadonlyArray<{ label: string; secs: number }> = [
  { label: "24 hours", secs: 24 * 60 * 60 },
  { label: "7 days", secs: 7 * 24 * 60 * 60 },
  { label: "30 days", secs: 30 * 24 * 60 * 60 },
  { label: "Never expires", secs: NEVER_EXPIRES_SECS },
];

/**
 * The preset selected when the dialog opens — 7 days, mirroring the Rust
 * policy default (`shared_drives/commands.rs::resolve_invite_policy`).
 * Purely a DISPLAY concern: the modal always sends its selection
 * explicitly, and an IPC caller that omits the param gets the Rust
 * default regardless of this value.
 */
export const DEFAULT_INVITE_TTL_SECS = 7 * 24 * 60 * 60;

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
