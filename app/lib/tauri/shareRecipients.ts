// Typed wrappers around links per person and Insights grouped by person
// (`src-tauri/src/shares/recipients.rs`). Rust seals and opens the names,
// makes and rebuilds each person's link, and decides what is shown; these
// types only describe what crosses IPC.

import { invoke } from "@tauri-apps/api/core";

/** One person a file went to, with a link of their own. */
export interface RecipientPerson {
  shareToken: string;
  /** The name it was made for; `null` when it can't be opened here. */
  name: string | null;
  /** The link, when this computer can rebuild it. */
  url: string | null;
  /** For a name that is an email: opens the mail app with the link in it. */
  mailto: string | null;
  /**
   * Made from a link with an NDA, and its own NDA isn't set yet, so it opens
   * for no one. Offer Try again (`retryRecipientNda`) instead of the link.
   */
  ndaPending: boolean;
}

/** Links per person for one file link. */
export interface RecipientLinks {
  /** Draw the section at all. Without it nothing is drawn. */
  offered: boolean;
  /** People can be added on this computer. */
  canAdd: boolean;
  /** Oldest first. */
  people: RecipientPerson[];
  /**
   * Links per person come with paid Drive plans: `false` on the free plan,
   * where the upgrade prompt takes the place of adding people; `null` when
   * the plan could not be read.
   */
  inPlan: boolean | null;
}

/**
 * Rust's refusal on the free plan (its `RECIPIENTS_NOT_IN_PLAN`, word for
 * word), which shows the upgrade prompt instead of an error line.
 */
export const RECIPIENTS_NOT_IN_PLAN = "Links per person are available on paid Drive plans.";

export function isRecipientsNotInPlan(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { kind, message } = err as { kind?: unknown; message?: unknown };
  return kind === "Validation" && message === RECIPIENTS_NOT_IN_PLAN;
}

/** What adding people did. */
export interface AddedRecipients {
  people: RecipientPerson[];
  /** The names not made, to put back in the box. */
  left: string;
  /** Why, in Rust's words. */
  error: string | null;
}

/** One live link of a file's group, in the People tab. */
export interface GroupPerson {
  shareToken: string;
  /** Made for a person, so it can be revoked here. The file's own link is not. */
  recipient: boolean;
  name: string | null;
  views: number;
  viewers: number;
  /** "3 of 12 pages", or `null`. */
  pages: string | null;
  /** Emails its viewers proved, checked in Rust. */
  emails: string[];
}

export interface GroupInsights {
  /** Draw the People tab. */
  offered: boolean;
  people: GroupPerson[];
  /** Some names can't be opened on this computer. */
  namesHidden: boolean;
  overVisitBudget: boolean;
}

export function getRecipientLinks(shareToken: string): Promise<RecipientLinks> {
  return invoke<RecipientLinks>("share_recipient_links", { shareToken });
}

/** `names` as typed: Rust splits it on commas, semicolons and new lines. */
export function addRecipientLinks(shareToken: string, names: string): Promise<AddedRecipients> {
  return invoke<AddedRecipients>("share_add_recipient_links", { shareToken, names });
}

/** Set the NDA on `recipientToken`, a link made from `shareToken` that is still waiting for it. */
export function retryRecipientNda(shareToken: string, recipientToken: string): Promise<void> {
  return invoke<void>("share_retry_recipient_nda", { shareToken, recipientToken });
}

export function revokeRecipientLink(shareToken: string): Promise<void> {
  return invoke<void>("share_revoke_recipient_link", { shareToken });
}

export function getGroupInsights(shareToken: string): Promise<GroupInsights> {
  return invoke<GroupInsights>("share_group_insights", { shareToken });
}
