// The words on each rule card: On or Off and one short value. Pure, so the
// wording is tested without a dialog. Which rules a link offers, and what it
// has, come from Rust (`LinkGate`, `LinkNda`, the link's settings); this only
// words them, in the console's labels and order.

import type { LinkGate } from "@/app/lib/tauri/shareGate";
import type { LinkNda } from "@/app/lib/tauri/shareNda";

export const RULE_LABELS = {
  gate: "Ask for email",
  allowList: "Allow list",
  nda: "NDA",
  watermark: "Watermark",
  download: "Download",
  expiry: "Expiry",
  password: "Password",
} as const;

export type RuleId = keyof typeof RULE_LABELS;

/** The console's order. */
export const RULE_ORDER: readonly RuleId[] = ["gate", "allowList", "nda", "watermark", "download", "expiry", "password"];

export const GATE_VALUE = "Code by email";
/** Ask for email while it is off: nothing is asked. */
export const GATE_OFF_VALUE = "Not asked";
/** The allow list with nobody on it (or no gate): anyone may open it. */
export const ANYONE = "Anyone";
export const NDA_OFF_VALUE = "Not asked";
export const NDA_ELSEWHERE = "Set on another device";
export const NDA_PASSWORD_VALUE = "Not on password links";
export const NDA_PASSWORD_REASON = "The NDA is encrypted with the link's key, which needs the link's password.";
/** The date always; the viewer's email only when the link asks for one. */
export const WATERMARK_VALUE = "Date";
export const WATERMARK_WITH_EMAIL = "Date and email";
export const WATERMARK_WHEN_VIEW_ONLY = "When download is off";
export const WATERMARK_PDF_ONLY = "PDFs only";
export const DOWNLOAD_ON_VALUE = "Viewers can save it";
export const DOWNLOAD_OFF_VALUE = "View only";
export const EXPIRY_NEVER = "Never";
export const PASSWORD_VALUE = "Set when the link was made";
export const PASSWORD_OFF_VALUE = "None";

/**
 * A card's state and value. `on` is `null` for a rule that is not a switch
 * (the Allow list, Expiry, a Watermark the file can't have): its value says
 * it all, and an On or Off beside it would only repeat or contradict it.
 */
export interface RuleSummary {
  on: boolean | null;
  value: string;
}

export function gateSummary(on: boolean): RuleSummary {
  return { on, value: on ? GATE_VALUE : GATE_OFF_VALUE };
}

/**
 * The allow list in a few words, short enough never to be cut: "2 allowed,
 * 1 blocked", or "Anyone" with nobody listed. Counted from the lists when
 * they open here, else from the counts the server keeps, so it reads the
 * same whether or not the Drive is unlocked. Never On or Off: the gate's own
 * card says that.
 */
export function allowListSummary(gate: Pick<LinkGate, "on" | "allowCount" | "blockCount" | "lists">): RuleSummary {
  const parts: string[] = [];
  if (gate.on) {
    const allowed = gate.lists ? gate.lists.allow.length : gate.allowCount;
    const blocked = gate.lists ? gate.lists.block.length : gate.blockCount;
    if (allowed > 0) parts.push(`${allowed} allowed`);
    if (blocked > 0) parts.push(`${blocked} blocked`);
  }
  return { on: null, value: parts.length > 0 ? parts.join(", ") : ANYONE };
}

/** The NDA: the text's first line while it has one. */
export function ndaSummary(nda: Pick<LinkNda, "on" | "text">): RuleSummary {
  if (!nda.on) return { on: false, value: NDA_OFF_VALUE };
  const first = nda.text
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return { on: true, value: first ?? NDA_ELSEWHERE };
}

const PDF = /\.pdf$/i;

export const WATERMARK_OFF_VALUE = "None";

/** Whether the share page can draw the watermark on this file: PDFs only, as on the console. */
export function isWatermarkable(fileName: string, mimeType: string | null): boolean {
  return PDF.test(fileName.trim()) || mimeType === "application/pdf";
}

/**
 * The watermark as the share page draws it. `watermark` is the link's own
 * switch where the server has one; `null` elsewhere, where the page draws it
 * on a PDF while downloads are off. It carries the date, and the viewer's
 * email when the link asks for one (`emailAsked`).
 */
export function watermarkSummary(
  fileName: string,
  mimeType: string | null,
  download: boolean | null,
  watermark: boolean | null = null,
  emailAsked = false,
): RuleSummary {
  if (!isWatermarkable(fileName, mimeType)) return { on: null, value: WATERMARK_PDF_ONLY };
  const drawn = { on: true, value: emailAsked ? WATERMARK_WITH_EMAIL : WATERMARK_VALUE };
  if (watermark !== null) return watermark ? drawn : { on: false, value: WATERMARK_OFF_VALUE };
  if (download === false) return drawn;
  return { on: false, value: WATERMARK_WHEN_VIEW_ONLY };
}

export function downloadSummary(download: boolean): RuleSummary {
  return download ? { on: true, value: DOWNLOAD_ON_VALUE } : { on: false, value: DOWNLOAD_OFF_VALUE };
}

/** The expiry as a date ("Dec 20, 2026"), so it stays true a week later, or "Never". */
export function expirySummary(expiresAt: string | null): RuleSummary {
  if (expiresAt === null) return { on: null, value: EXPIRY_NEVER };
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return { on: null, value: expiresAt };
  return { on: null, value: new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" }) };
}

export function passwordSummary(on: boolean): RuleSummary {
  return { on, value: on ? PASSWORD_VALUE : PASSWORD_OFF_VALUE };
}
