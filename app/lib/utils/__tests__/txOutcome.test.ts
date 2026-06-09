import { describe, it, expect } from "vitest";
import {
  resolveTxOutcome,
  TxSubmittedUnconfirmedError,
  type TxOutcome,
} from "../txOutcome";

describe("resolveTxOutcome", () => {
  it("resolves a finalized outcome to its tx hash", () => {
    const outcome: TxOutcome = { status: "finalized", txHash: "0xabc" };
    expect(resolveTxOutcome(outcome)).toEqual({ txHash: "0xabc" });
  });

  it("throws the no-retry error for submittedUnconfirmed, preserving the hash", () => {
    // This is the security-critical branch (R-01): a submitted-but-unconfirmed
    // tx may already be on-chain, so callers must get a distinct error type and
    // NEVER auto-resubmit.
    const outcome: TxOutcome = {
      status: "submittedUnconfirmed",
      txHash: "0xdef",
      reason: "websocket disconnected",
    };
    let caught: unknown;
    try {
      resolveTxOutcome(outcome);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TxSubmittedUnconfirmedError);
    expect((caught as TxSubmittedUnconfirmedError).txHash).toBe("0xdef");
    expect((caught as Error).message).toContain("websocket disconnected");
  });

  it("throws a plain (retry-safe) Error for finalizedFailed, not the no-retry type", () => {
    const outcome: TxOutcome = {
      status: "finalizedFailed",
      txHash: "0x1",
      reason: "InsufficientBalance",
    };
    let caught: unknown;
    try {
      resolveTxOutcome(outcome);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TxSubmittedUnconfirmedError);
    expect((caught as Error).message).toContain("InsufficientBalance");
  });

  it("throws a plain (retry-safe) Error for rejectedAtSubmission, not the no-retry type", () => {
    const outcome: TxOutcome = {
      status: "rejectedAtSubmission",
      reason: "1010: Invalid Transaction",
    };
    let caught: unknown;
    try {
      resolveTxOutcome(outcome);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TxSubmittedUnconfirmedError);
  });
});
