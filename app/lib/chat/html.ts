/**
 * Allow-list HTML sanitiser for Matrix `formatted_body`.
 *
 * Matrix clients send a constrained HTML subset (spec §11.2.1.1). We keep
 * only that subset, re-serialise every text node escaped, and drop any
 * attribute that is not explicitly allowed. This is a tokenizer rather than
 * a DOM parse so the result is identical on the server, in tests and in the
 * browser, and so nothing can smuggle a DOM quirk through.
 */

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "strike",
  "code",
  "pre",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "span",
  "sub",
  "sup",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "div",
]);

/** Elements whose entire content is dropped (not just the tag). */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "mx-reply"]);

const VOID_TAGS = new Set(["br", "hr"]);

const URL_SCHEMES = /^(https?:|mailto:|matrix:)/i;
const MATRIX_TO = /^https:\/\/matrix\.to\/#\//i;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Detached element used to decode entities with the browser's own HTML
 * tokenizer. Created lazily and reused: the parse cost is in the tokenizer,
 * not the allocation.
 */
let decoder: HTMLElement | null = null;

/**
 * Decode character references (`&amp;`, `&#128512;`, `&hellip;`, ...) in a
 * text run. The browser does it when `document` exists: every named
 * reference HTML knows, out-of-range and surrogate code points mapped to
 * U+FFFD the way the spec says, never an exception. `<` is escaped first so
 * the run can never open an element, and the result is read back as text,
 * so nothing is executed or fetched.
 *
 * Without a DOM (tests, server) only the five XML references and `&nbsp;`
 * are decoded; anything else is left as written, which `escapeHtml`
 * then renders literally. Wrong-looking, never throwing.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  if (typeof document !== "undefined") {
    decoder ??= document.createElement("div");
    decoder.innerHTML = text.replace(/</g, "&lt;");
    const decoded = decoder.textContent ?? "";
    decoder.textContent = "";
    return decoded;
  }
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const name = match[1].toLowerCase();
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!URL_SCHEMES.test(trimmed)) return null;
  return trimmed;
}

/** Attributes we keep, per tag. Everything else is dropped. */
function allowedAttributes(tag: string, attrs: Record<string, string>): string {
  const out: string[] = [];
  if (tag === "a") {
    const href = attrs.href ? safeHref(attrs.href) : null;
    if (href) {
      out.push(`href="${escapeHtml(href)}"`);
      if (!MATRIX_TO.test(href) && !/^matrix:/i.test(href)) out.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
      if (MATRIX_TO.test(href)) out.push('data-mention="true"');
    }
  } else if (tag === "code" && attrs.class) {
    const lang = /^language-([a-zA-Z0-9_+-]+)$/.exec(attrs.class.trim());
    if (lang) out.push(`class="language-${escapeHtml(lang[1])}"`);
  } else if (tag === "span" && attrs["data-mx-spoiler"] !== undefined) {
    out.push('data-mx-spoiler=""');
  } else if (tag === "ol" && attrs.start && /^\d+$/.test(attrs.start)) {
    out.push(`start="${attrs.start}"`);
  }
  return out.length ? ` ${out.join(" ")}` : "";
}

/**
 * Sanitise an HTML fragment. Text is always re-escaped, so output is safe to
 * assign via `innerHTML`. Falls back to escaping everything if the input is
 * absurdly large (we never render 1 MB of markup).
 */
export function sanitizeHtml(input: string): string {
  if (input.length > 200_000) return escapeHtml(input.slice(0, 200_000));
  const out: string[] = [];
  const open: string[] = [];
  let dropDepth: string | null = null;
  const tokenRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>|[^<]+|</g;
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(input))) {
    const token = match[0];
    if (token.startsWith("<!--")) continue;
    const tagName = match[1]?.toLowerCase();

    if (!tagName) {
      if (dropDepth) continue;
      out.push(escapeHtml(decodeEntities(token)));
      continue;
    }

    const isClose = token.startsWith("</");
    if (dropDepth) {
      if (isClose && tagName === dropDepth) dropDepth = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tagName)) {
      if (!isClose) dropDepth = tagName;
      continue;
    }
    if (!ALLOWED_TAGS.has(tagName)) continue; // unwrap: keep children text

    if (isClose) {
      const index = open.lastIndexOf(tagName);
      if (index === -1) continue;
      // Close everything opened after it too (mis-nesting).
      while (open.length > index) out.push(`</${open.pop()}>`);
      continue;
    }

    if (VOID_TAGS.has(tagName)) {
      out.push(`<${tagName}>`);
      continue;
    }
    out.push(`<${tagName}${allowedAttributes(tagName, parseAttributes(match[2] ?? ""))}>`);
    open.push(tagName);
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return out.join("");
}

/** Strip all tags; used for previews and notifications. */
export function htmlToText(input: string): string {
  return decodeEntities(
    input
      .replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|blockquote|h[1-6]|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;

/**
 * Plain-text body to HTML: escape, then autolink URLs and turn `@user:server`
 * mentions into matrix.to anchors. Newlines become `<br>`.
 */
export function plainTextToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(URL_RE, (url) => {
    const href = url.replace(/&amp;/g, "&");
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
  });
  return linked.replace(/\n/g, "<br>");
}
