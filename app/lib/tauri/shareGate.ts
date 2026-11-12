// Typed wrappers around the email gate commands (`src-tauri/src/shares/gate.rs`):
// "Ask for email" on a file link, with its allow and block lists. Rust reads
// the lists, checks them, seals the owner's copy and decides what the plan
// allows; these types only describe what crosses IPC.

import { invoke } from "@tauri-apps/api/core";

export interface GateLists {
  allow: string[];
  block: string[];
}

/** A link's email gate as the owner sees it. */
export interface LinkGate {
  /** The server has email gates. Without it nothing is drawn. */
  offered: boolean;
  on: boolean;
  allowCount: number;
  blockCount: number;
  /** The lists, or `null` while off and when they can't be opened here. */
  lists: GateLists | null;
  /** `false` on the free plan, `null` when the plan could not be read. */
  inPlan: boolean | null;
}

/**
 * Rust's refusal on the free plan (its `GATE_NOT_IN_PLAN`, word for word),
 * which shows the upgrade prompt instead of a toast.
 */
export const GATE_NOT_IN_PLAN = "Asking for an email is available on paid Drive plans.";

export function isGateNotInPlan(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { kind, message } = err as { kind?: unknown; message?: unknown };
  return kind === "Validation" && message === GATE_NOT_IN_PLAN;
}

export function getLinkGate(shareToken: string): Promise<LinkGate> {
  return invoke<LinkGate>("share_get_gate", { shareToken });
}

/**
 * Turn the gate on, or save its lists, from what the owner typed in each box
 * (both empty: anyone who confirms an email). Rust reads and checks the
 * entries and answers the gate as stored.
 */
export function setLinkGate(shareToken: string, allow: string, block: string): Promise<LinkGate> {
  return invoke<LinkGate>("share_set_gate", { shareToken, allow, block });
}

export function removeLinkGate(shareToken: string): Promise<void> {
  return invoke<void>("share_remove_gate", { shareToken });
}
