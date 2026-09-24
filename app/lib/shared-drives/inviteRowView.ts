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
  /**
   * Who minted it, as the row should read it. Null when the server has no
   * provenance for the invite, or when the reader minted it themselves --
   * on a drive only its owner can invite into, "Minted by you" on every row
   * is noise. It earns its place once a manager can mint too.
   */
  mintedBy: string | null;
  /**
   * For a MAILED invitation: who it went to and how far it has got. Null on
   * a link invite. `canApprove` is decided by the stage alone, never by the
   * recipient's key being present (it stays after approval too).
   */
  email: {
    recipient: string | null;
    stage: string;
    canApprove: boolean;
  } | null;
}

/** How each mailed-invite stage reads on the row. */
const EMAIL_STAGE_LABELS: Record<string, string> = {
  sent: "Sent, not opened yet",
  awaiting_seal: "Opened, waiting for your approval",
  sealed: "Approved, waiting for them to join",
};

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
    mintedBy?: string;
    pathPrefix?: string | null;
    recipientEmail?: string | null;
    emailStatus?: string | null;
  },
  now: Date = new Date(),
  /** The reader's own address, so their own links say nothing extra. */
  viewerSs58?: string | null,
): InviteRowView {
  const role = driveRoleLabel(parseDriveRole(invite.role));
  const folderBit = invite.pathPrefix?.trim()
    ? ` · ${invite.pathPrefix.trim()}`
    : "";
  const mailed = invite.emailStatus
    ? EMAIL_STAGE_LABELS[invite.emailStatus] ?? null
    : null;
  // A mailed invitation is single use and addressed to one person, so "0 of
  // 1 used" says nothing; who it went to is the useful half.
  const summary = mailed
    ? `${role}${folderBit} · by email`
    : `${role}${folderBit} · ${invite.useCount} of ${invite.maxUses} used`;

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

  const minter = invite.mintedBy?.trim();
  return {
    summary,
    expiry,
    live: invite.valid && deadReason === null,
    deadReason,
    mintedBy: !minter || minter === viewerSs58 ? null : minter,
    email: mailed
      ? {
          recipient: invite.recipientEmail?.trim() || null,
          stage: mailed,
          canApprove:
            invite.emailStatus === "awaiting_seal" &&
            invite.valid &&
            deadReason === null,
        }
      : null,
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
