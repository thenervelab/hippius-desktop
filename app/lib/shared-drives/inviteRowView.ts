import { driveRoleLabel, parseDriveRole } from "./roles";

/** How one invite row should read. */
export interface InviteRowView {
  /** "Editor · 2 of 50 used" — the link's power and how far it has gone. */
  summary: string;
  /** "Expires 4 Oct 2026", "Never expires", or "Expired". */
  expiry: string;
  /** Whether the link can still admit anyone. */
  live: boolean;
  /** Why it cannot, when it cannot. Null while live. */
  deadReason: "revoked" | "expired" | "used-up" | null;
}

/**
 * The server's own 100-year cap, which is how "never expires" is expressed on
 * the wire. A date that far out is a sentinel, not a real expiry, and showing
 * it as "Expires 12 Sep 2126" would be technically true and useless.
 */
const NEVER_EXPIRES_AFTER_YEARS = 50;

function isSentinelExpiry(expiresAt: string, now: Date): boolean {
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return false;
  const years = (expiry.getTime() - now.getTime()) / (365 * 24 * 60 * 60 * 1000);
  return years > NEVER_EXPIRES_AFTER_YEARS;
}

/**
 * Project one invite into what the row shows.
 *
 * `valid` is the server's own verdict and is trusted first — it already
 * accounts for revocation, expiry and exhaustion together. The individual
 * reasons are derived only to SAY why, because "this link no longer works"
 * without a reason leaves the user unsure whether to mint another.
 */
export function inviteRowView(
  invite: {
    role: string;
    expiresAt: string;
    maxUses: number;
    useCount: number;
    revoked: boolean;
    valid: boolean;
  },
  now: Date = new Date(),
): InviteRowView {
  const role = driveRoleLabel(parseDriveRole(invite.role));
  const summary = `${role} · ${invite.useCount} of ${invite.maxUses} used`;

  const never = isSentinelExpiry(invite.expiresAt, now);
  const expiryDate = new Date(invite.expiresAt);
  const expired =
    !never &&
    !Number.isNaN(expiryDate.getTime()) &&
    expiryDate.getTime() <= now.getTime();

  const expiry = never
    ? "Never expires"
    : expired
      ? "Expired"
      : Number.isNaN(expiryDate.getTime())
        ? "Expiry unknown"
        : `Expires ${expiryDate.toLocaleDateString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}`;

  // Order matters: revoked is the most specific thing a user did, and it
  // should not be reported as "expired" just because time also passed.
  const deadReason = invite.revoked
    ? ("revoked" as const)
    : expired
      ? ("expired" as const)
      : invite.useCount >= invite.maxUses
        ? ("used-up" as const)
        : null;

  return {
    summary,
    expiry,
    live: invite.valid && deadReason === null,
    deadReason,
  };
}

/** One line saying why a link is dead, for the row. */
export function deadReasonLabel(reason: InviteRowView["deadReason"]): string {
  switch (reason) {
    case "revoked":
      return "Revoked";
    case "expired":
      return "Expired";
    case "used-up":
      return "All uses taken";
    default:
      return "";
  }
}
