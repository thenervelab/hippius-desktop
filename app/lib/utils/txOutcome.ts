/**
 * Frontend mirror of the Rust `TxOutcome` enum (`blockchain/types.rs`).
 *
 * The Rust signing commands no longer throw on a finalization-watch error —
 * they return a typed outcome so the UI can tell a transaction that was merely
 * *rejected* (safe to retry) from one that was *submitted but unconfirmed*
 * (may already be on-chain — must NOT be auto-resent). Re-firing the latter is
 * the double-spend the audit flagged (R-01).
 *
 * `resolveTxOutcome` collapses the four variants into the success/throw shape
 * the dialogs already use, but throws a distinct {@link TxSubmittedUnconfirmedError}
 * for the do-not-resend case so callers can suppress their "Try Again" button.
 */

export type TxOutcome =
  | { status: "finalized"; txHash: string }
  | { status: "finalizedFailed"; txHash: string; reason: string }
  | { status: "submittedUnconfirmed"; txHash: string; reason: string }
  | { status: "rejectedAtSubmission"; reason: string };

/**
 * Thrown for a `submittedUnconfirmed` outcome: the node accepted the extrinsic
 * but we lost track of it before finalization. The transaction MAY have landed,
 * so the UI must show "pending — do not resend" rather than offering a retry.
 */
export class TxSubmittedUnconfirmedError extends Error {
  readonly txHash: string;

  constructor(txHash: string, reason: string) {
    super(
      reason
        ? `Transaction submitted but not yet confirmed: ${reason}`
        : "Transaction submitted but not yet confirmed.",
    );
    this.name = "TxSubmittedUnconfirmedError";
    this.txHash = txHash;
  }
}

/**
 * Interpret a {@link TxOutcome}:
 * - `finalized` → resolves with the extrinsic hash.
 * - `submittedUnconfirmed` → throws {@link TxSubmittedUnconfirmedError} (no retry).
 * - `finalizedFailed` / `rejectedAtSubmission` → throws a plain `Error` (the
 *   call definitively did not take effect, so a retry is a safe new transaction).
 */
export function resolveTxOutcome(outcome: TxOutcome): { txHash: string } {
  switch (outcome.status) {
    case "finalized":
      return { txHash: outcome.txHash };
    case "submittedUnconfirmed":
      throw new TxSubmittedUnconfirmedError(outcome.txHash, outcome.reason);
    case "finalizedFailed":
      throw new Error(outcome.reason || "Transaction failed on-chain.");
    case "rejectedAtSubmission":
      throw new Error(outcome.reason || "Transaction was rejected.");
  }
}
