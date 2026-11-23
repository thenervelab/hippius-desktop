// Typed wrappers around the NDA commands (`src-tauri/src/shares/nda.rs`):
// "Ask to accept an NDA" on a file link, and who accepted which text. Rust
// seals and opens the text, checks viewers' emails and decides what the plan
// allows; these types only describe what crosses IPC.

import { invoke } from "@tauri-apps/api/core";

/** A link's NDA setting as the owner sees it. */
export interface LinkNda {
  /** Draw the switch. Without it nothing is drawn. */
  offered: boolean;
  /** The link has a text. */
  on: boolean;
  /** The text, or `null` while off and when it can't be opened here. */
  text: string | null;
  /** A text can be sealed on this computer. */
  editable: boolean;
  /** `false` on the free plan, `null` when the plan could not be read. */
  inPlan: boolean | null;
}

/** One viewer's accept of one text. */
export interface NdaAccept {
  id: number;
  viewerId: string;
  /** The email they proved on a link that asks for one, checked in Rust. */
  email: string | null;
  /** The name the signer typed when they accepted, opened in Rust; `null` without one. */
  signerName: string | null;
  acceptedAt: string;
  /** An accept of a text since replaced or removed. */
  earlier: boolean;
}

/** One page of a link's accepts, with its current text. */
export interface NdaAccepts {
  /** The server has NDA texts. Without it there is no tab. */
  offered: boolean;
  hasText: boolean;
  /** The text, or `null` without one or when it can't be opened here. */
  text: string | null;
  accepts: NdaAccept[];
  nextAfter: number | null;
}

/**
 * Rust's refusal on the free plan (its `NDA_NOT_IN_PLAN`, word for word),
 * which shows the upgrade prompt instead of a toast.
 */
export const NDA_NOT_IN_PLAN = "Asking to accept an NDA is available on paid Drive plans.";

export function isNdaNotInPlan(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { kind, message } = err as { kind?: unknown; message?: unknown };
  return kind === "Validation" && message === NDA_NOT_IN_PLAN;
}

export function getLinkNda(shareToken: string): Promise<LinkNda> {
  return invoke<LinkNda>("share_get_nda", { shareToken });
}

/** Set or replace the text, as typed. Rust trims, checks and seals it. */
export function setLinkNda(shareToken: string, text: string): Promise<LinkNda> {
  return invoke<LinkNda>("share_set_nda", { shareToken, text });
}

/** Remove the text. Works on every plan. */
export function removeLinkNda(shareToken: string): Promise<void> {
  return invoke<void>("share_remove_nda", { shareToken });
}

export function getNdaAccepts(shareToken: string, after: number): Promise<NdaAccepts> {
  return invoke<NdaAccepts>("share_nda_accepts", { shareToken, after });
}
