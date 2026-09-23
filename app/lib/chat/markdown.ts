/**
 * Slack-style markdown subset -> Matrix HTML (`org.matrix.custom.html`).
 *
 * Supported: `*bold*` / `**bold**`, `_italic_`, `~strike~` / `~~strike~~`,
 * `` `code` ``, fenced code blocks, `> quote` lines, `- ` / `1. ` lists,
 * bare URLs, `@user:server` mentions (resolved to matrix.to pills by the
 * caller through `mentionHtml`). Anything else is escaped text with line
 * breaks. Deliberately small: it is a chat composer, not a document editor.
 */

import { escapeHtml } from "@/lib/chat/html";

export interface MentionTarget {
  userId: string;
  displayName: string;
}

const URL_RE = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

/**
 * Bounds. A Matrix event is capped at 64 KiB on the wire, so anything past
 * `MAX_SOURCE_LENGTH` cannot be sent anyway: such drafts are returned as
 * plain text without running the parser. `MAX_INLINE_LINE_LENGTH` bounds the
 * inline pass, whose emphasis regexes backtrack within a line: a line longer
 * than this is escaped verbatim (no bold, links or mentions) so the cost
 * stays linear in the draft size.
 */
export const MAX_SOURCE_LENGTH = 60_000;
export const MAX_INLINE_LINE_LENGTH = 4_000;

/** Opening fence: three backticks, optional info string. Anything after the
 *  first word is ignored, as CommonMark does. */
const FENCE_OPEN_RE = /^```(?:\s*([\w+-]+))?[^`]*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const QUOTE_RE = /^>\s?/;
const BULLET_RE = /^[-*]\s+/;
const ORDERED_RE = /^\d+\.\s+/;

// Placeholders for protected spans; private-use code points never occur in chat text.
const CODE_MARK = "\uE000";
const LINK_MARK = "\uE001";
const CODE_RESTORE = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g");
const LINK_RESTORE = new RegExp(`${LINK_MARK}(\\d+)${LINK_MARK}`, "g");

function inline(text: string, mentions: readonly MentionTarget[]): string {
  if (text.length > MAX_INLINE_LINE_LENGTH) return escapeHtml(text);
  // Protect code spans first: nothing inside is formatted.
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `${CODE_MARK}${codeSpans.length - 1}${CODE_MARK}`;
  });

  out = escapeHtml(out);

  // Links before emphasis so underscores in URLs survive.
  const links: string[] = [];
  out = out.replace(URL_RE, (url) => {
    const href = url.replace(/&amp;/g, "&");
    links.push(`<a href="${escapeHtml(href)}">${url}</a>`);
    return `${LINK_MARK}${links.length - 1}${LINK_MARK}`;
  });

  // Mentions: longest display names first so "Jo" does not eat "Joanna".
  const sorted = [...mentions].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const target of sorted) {
    const name = escapeHtml(target.displayName);
    const pattern = new RegExp(`(^|[^\\w@])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\w])`, "g");
    out = out.replace(pattern, (_, lead: string) => `${lead}${mentionHtml(target)}`);
  }
  // Raw ids `@alice:hippius.com`.
  out = out.replace(
    /(^|[^\w])(@[a-z0-9._=/+-]+:[a-z0-9.-]+(?::\d+)?)/gi,
    (_, lead: string, id: string) => `${lead}${mentionHtml({ userId: id, displayName: id })}`,
  );

  out = out
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=$|[^\w*])/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?=$|[^\w_])/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?=$|[^\w~])/g, "$1<del>$2</del>");

  out = out.replace(LINK_RESTORE, (_, i: string) => links[Number(i)]);
  out = out.replace(CODE_RESTORE, (_, i: string) => codeSpans[Number(i)]);
  return out;
}

/** Does this line open a block (fence, quote, list)? Used to end a paragraph. */
function startsBlock(line: string): boolean {
  return FENCE_OPEN_RE.test(line) || QUOTE_RE.test(line) || BULLET_RE.test(line) || ORDERED_RE.test(line);
}

export function mentionHtml(target: MentionTarget): string {
  return `<a href="https://matrix.to/#/${encodeURIComponent(target.userId)}">${escapeHtml(target.displayName)}</a>`;
}

export interface Rendered {
  /** Plain-text `body` (mentions expanded to display names, markdown kept). */
  body: string;
  /** `formatted_body`, or `null` if the text has no formatting worth sending. */
  html: string | null;
  /** User ids mentioned (`m.mentions`). */
  mentionedUserIds: string[];
  mentionsRoom: boolean;
}

/** Render a composer draft. `mentions` are the pills the user picked. */
export function renderMarkdown(source: string, mentions: readonly MentionTarget[] = []): Rendered {
  const mentionedUserIds = [...new Set(mentions.map((m) => m.userId))];
  // Plain body: swap mention pills for their display names, leave markdown as typed.
  let body = source;
  for (const target of mentions) body = body.split(`@${target.displayName}`).join(target.displayName);

  if (source.length > MAX_SOURCE_LENGTH) {
    // Too large to send as a Matrix event anyway; do not spend parser time on it.
    return { body, html: null, mentionedUserIds, mentionsRoom: false };
  }

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;
  // Invariant: every pass through this loop advances `i` by at least one
  // line, whatever the line looks like. A line that opens a block but does
  // not match any block grammar is a paragraph line, never a stall.
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or EOF)
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      blocks.push(`<pre><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) quote.push(lines[i++].replace(QUOTE_RE, ""));
      blocks.push(`<blockquote>${quote.map((q) => inline(q, mentions)).join("<br>")}</blockquote>`);
      continue;
    }
    if (BULLET_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET_RE.test(lines[i])) items.push(lines[i++].replace(BULLET_RE, ""));
      blocks.push(`<ul>${items.map((it) => `<li>${inline(it, mentions)}</li>`).join("")}</ul>`);
      continue;
    }
    if (ORDERED_RE.test(line)) {
      const items: string[] = [];
      const start = Number(/^(\d+)\./.exec(line)?.[1] ?? "1");
      while (i < lines.length && ORDERED_RE.test(lines[i])) items.push(lines[i++].replace(ORDERED_RE, ""));
      blocks.push(`<ol${start !== 1 ? ` start="${start}"` : ""}>${items.map((it) => `<li>${inline(it, mentions)}</li>`).join("")}</ol>`);
      continue;
    }
    // Paragraph: this line, plus following lines that open no block.
    const para: string[] = [lines[i++]];
    while (i < lines.length && !startsBlock(lines[i])) para.push(lines[i++]);
    blocks.push(para.map((p) => inline(p, mentions)).join("<br>"));
  }
  const html = blocks.join("");

  const plainEquivalent = escapeHtml(source).replace(/\n/g, "<br>");
  const hasFormatting = html !== plainEquivalent;
  for (const match of source.matchAll(/(^|[^\w])(@[a-z0-9._=/+-]+:[a-z0-9.-]+(?::\d+)?)/gi)) {
    if (!mentionedUserIds.includes(match[2])) mentionedUserIds.push(match[2]);
  }
  const mentionsRoom = /(^|\s)@(room|channel|here|everyone)(?=\s|$|[.,!?])/i.test(source);

  return { body, html: hasFormatting ? html : null, mentionedUserIds, mentionsRoom };
}
