import type { FileFailureRecord } from "@/app/lib/types/fileFailure";

/**
 * Copy for a ciphertext this device's key cannot open.
 *
 * Must stay word-identical to Rust's `UNDECRYPTABLE_DISPLAY_REASON` — the
 * live-event path renders the Rust string and the persisted-row path renders
 * this one, and a user can see both at once. Pinned by
 * `src-tauri/tests/failure_copy_parity.rs`, not by this comment.
 */
export const UNDECRYPTABLE_MESSAGE =
  "Can't be decrypted on this device — needs to be re-uploaded or removed.";

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
    case "gone":
      // Must read identically to Rust's
      // `FileFailureKindPayload::Gone::display_reason()`. A local file that
      // left disk between plan and open — not a connection fault, not a
      // missing server object.
      return "File disappeared before upload — will retry.";
    case "undecryptable":
      // Must read identically to Rust's `UNDECRYPTABLE_DISPLAY_REASON`.
      // Deliberately NOT "will retry": hcfs quarantines the file after two
      // failed attempts on the same revision and stops fetching it, so the
      // retry wording every other case uses would promise something that
      // never happens.
      return UNDECRYPTABLE_MESSAGE;
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

/**
 * Whether retrying this failure can possibly help.
 *
 * Every other kind is either self-resolving or fixable by the user and worth
 * a retry button. `undecryptable` is neither: hcfs quarantines the file after
 * two failed attempts on the same remote revision and stops fetching it, and
 * `sp_retry_file` only clears the DESKTOP's record — it cannot reach that
 * quarantine. So a retry clears the badge, the next cycle skips the file
 * again, the re-emitted failure brings the badge straight back, and the user
 * is left clicking a button that flickers and never resolves.
 *
 * Releasing it needs a new remote revision (the owner re-uploading) or the
 * file being removed, which is what the copy tells the user to do. A genuine
 * "force retry" would need hcfs to expose clearing the quarantine; until it
 * does, offering the affordance is offering something that cannot work.
 */
export function isRetryableFailure(kind: FileFailureRecord["kind"]): boolean {
  return kind !== "undecryptable";
}

/**
 * Whether an authored failure reason describes something a retry can fix.
 *
 * The reason-string sibling of {@link isRetryableFailure}, for surfaces that
 * receive `FailedFileInfo` (which carries `error` text but no typed `kind`).
 * Matching authored copy — never server text — is the same approach Rust
 * takes in `is_gone_reason` / `is_transient_reason`.
 *
 * Plumbing the typed kind through the `hcfs_failed_files` payload would be
 * better and is a separate change; until then this keeps the modal from
 * offering a button that cannot work.
 */
export function isRetryableReason(reason: string | null): boolean {
  return reason?.trim() !== UNDECRYPTABLE_MESSAGE;
}
