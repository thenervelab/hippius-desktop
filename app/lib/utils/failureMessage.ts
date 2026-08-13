import type { FileFailureRecord } from "@/app/lib/types/fileFailure";

/** Format a cents integer as a `$x.xx` string (loss-free; divide only here). */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Human-readable reason for a persisted file-sync failure, derived from the
 * stable `kind` discriminant (never from parsing server text). This is the
 * presentation layer — the *decision* of which kind a failure is happens in
 * Rust; here we only phrase it.
 */
export function failureMessage(rec: FileFailureRecord): string {
  switch (rec.kind) {
    case "insufficientBalance": {
      const need =
        rec.requiredCents != null ? dollars(rec.requiredCents) : "more credits";
      const have = rec.balanceCents != null ? dollars(rec.balanceCents) : null;
      return have
        ? `Insufficient credits — needs ${need}, you have ${have}.`
        : `Insufficient credits — needs ${need}.`;
    }
    case "serverError":
      return rec.httpStatus != null
        ? `Server error (${rec.httpStatus}). Please try again.`
        : "Server error. Please try again.";
    case "network":
      return "Network error — couldn't reach the server. Check your connection.";
    case "changedWhileUploading":
      // Self-resolving: the next cycle rescans and re-uploads. Deliberately
      // says nothing about encryption — the crypto is fine, the file moved.
      return "File changed while uploading — will retry.";
    case "other":
    default:
      // `other` carries display text; fall back to a generic line if absent or
      // for an unrecognised future kind.
      return rec.message?.trim() || "Sync failed. Please try again.";
  }
}
