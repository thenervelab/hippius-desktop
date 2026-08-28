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
      // Must read identically to Rust's
      // `FileFailureKindPayload::ServerError { 429 }::display_reason()`.
      if (rec.httpStatus === 429) {
        return "Too many uploads in progress — will retry.";
      }
      return rec.httpStatus != null
        ? `Server error (${rec.httpStatus}). Please try again.`
        : "Server error. Please try again.";
    case "network":
      // Must read identically to Rust's
      // `FileFailureKindPayload::Network::display_reason()`. Origin/edge
      // resets stringify like "no wifi" in reqwest — do not send the user
      // to their router (report 2026-08-26).
      return "Couldn't reach the server — will retry.";
    case "changedWhileUploading":
      // Self-resolving: the next cycle rescans and re-uploads. Deliberately
      // says nothing about encryption — the crypto is fine, the file moved.
      return "File changed while uploading — will retry.";
    case "other":
    default: {
      // `other` carries display text; fall back to a generic line if absent or
      // for an unrecognised future kind. Pre-bump hcfs-client 429s land here
      // as the bare "Too many active upload sessions" sentence.
      const message = rec.message?.trim();
      if (message?.includes("Too many active upload sessions")) {
        return "Too many uploads in progress — will retry.";
      }
      return message || "Sync failed. Please try again.";
    }
  }
}
