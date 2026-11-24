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
export const ANYONE_WITH_EMAIL = "Anyone with an email";
export const NDA_OFF_VALUE = "Viewers accept your text first";
export const NDA_ELSEWHERE = "Set on another device";
export const WATERMARK_VALUE = "Email and date on each page";
export const WATERMARK_WHEN_VIEW_ONLY = "When download is off";
export const WATERMARK_PDF_ONLY = "PDFs only";
export const DOWNLOAD_ON_VALUE = "Viewers can save it";
export const DOWNLOAD_OFF_VALUE = "View only";
export const EXPIRY_NEVER = "Never";
export const PASSWORD_VALUE = "Set when the link was made";

export interface RuleSummary {
  on: boolean;
  value: string;
}

/** An entry with something before its `@` is an address; anything else a domain. */
function isEmail(entry: string): boolean {
  return /^[^@\s]+@/.test(entry);
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * The allow list in a few words: "acme.com, 1 email", "2 blocked". The
 * lists, when they open here; else the counts the server keeps.
 */
export function allowListSummary(gate: Pick<LinkGate, "on" | "allowCount" | "blockCount" | "lists">): RuleSummary {
  const parts: string[] = [];
  if (gate.on && gate.lists) {
    const domains = gate.lists.allow.filter((e) => !isEmail(e));
    const emails = gate.lists.allow.length - domains.length;
    if (domains.length > 0) {
      parts.push(domains.length > 2 ? `${domains.slice(0, 2).join(", ")} +${domains.length - 2}` : domains.join(", "));
    }
    if (emails > 0) parts.push(plural(emails, "email"));
    if (gate.lists.block.length > 0) parts.push(`${gate.lists.block.length} blocked`);
  } else if (gate.on) {
    if (gate.allowCount > 0) parts.push(`${gate.allowCount} allowed`);
    if (gate.blockCount > 0) parts.push(`${gate.blockCount} blocked`);
  }
  return parts.length > 0 ? { on: true, value: parts.join(", ") } : { on: false, value: ANYONE_WITH_EMAIL };
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

export const WATERMARK_OFF_VALUE = "Off";

/** Whether the share page can draw the watermark on this file: PDFs only, as on the console. */
export function isWatermarkable(fileName: string, mimeType: string | null): boolean {
  return PDF.test(fileName.trim()) || mimeType === "application/pdf";
}

/**
 * The watermark as the share page draws it. `watermark` is the link's own
 * switch where the server has one; `null` elsewhere, where the page draws it
 * on a PDF while downloads are off.
 */
export function watermarkSummary(
  fileName: string,
  mimeType: string | null,
  download: boolean | null,
  watermark: boolean | null = null,
): RuleSummary {
  if (!isWatermarkable(fileName, mimeType)) return { on: false, value: WATERMARK_PDF_ONLY };
  if (watermark !== null) return watermark ? { on: true, value: WATERMARK_VALUE } : { on: false, value: WATERMARK_OFF_VALUE };
  if (download === false) return { on: true, value: WATERMARK_VALUE };
  return { on: false, value: WATERMARK_WHEN_VIEW_ONLY };
}

export function downloadSummary(download: boolean): RuleSummary {
  return download ? { on: true, value: DOWNLOAD_ON_VALUE } : { on: false, value: DOWNLOAD_OFF_VALUE };
}

/** The expiry as a date ("Dec 20, 2026"), so it stays true a week later. */
export function expirySummary(expiresAt: string | null): RuleSummary {
  if (expiresAt === null) return { on: false, value: EXPIRY_NEVER };
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return { on: true, value: expiresAt };
  return { on: true, value: new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" }) };
}

export function passwordSummary(on: boolean): RuleSummary {
  return { on, value: PASSWORD_VALUE };
}
