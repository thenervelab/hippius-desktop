/**
 * Sanitisers for the two markup formats the viewer renders: HTML and SVG.
 *
 * Both are **untrusted documents**, not data. A synced `.html` or `.svg` can
 * carry script, event handlers, embedded frames and remote references, and it
 * is rendered inside the app's own WebView. The renderers isolate it as well
 * (a `sandbox=""` iframe for HTML, an inert `<img>` for SVG), so this module is
 * the second of two independent layers rather than the only one — an isolation
 * primitive that turned out to behave differently on one of the three WebViews
 * must not be the single thing standing between a file and script execution.
 *
 * Pure and DOM-only (no network, no eval), so every rule below is directly
 * unit-testable.
 */

/**
 * Elements removed outright.
 *
 * Three reasons, in order: they execute (`script`), they load or embed a
 * separate document (`iframe`, `object`, `embed`, `frame`, `applet`, `portal`),
 * or they re-point the document at somewhere else (`base`, `meta` — which can
 * carry a refresh redirect, and `link`, which pulls a remote stylesheet).
 * `form` goes because a submit is an outbound request carrying file content.
 */
const FORBIDDEN_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "applet",
  "frame",
  "frameset",
  "portal",
  "base",
  "meta",
  "link",
  "form",
  "noscript",
  // Media elements would stream a remote source on open; the preview shows a
  // document, and a `.html` file is not a way to autoplay from the network.
  "audio",
  "video",
  "source",
  "track",
]);

/** Attributes that resolve to a URL and therefore need a scheme check. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "xlink:href",
  "action",
  "formaction",
  "srcdoc",
  "data",
  "poster",
  "background",
  "ping",
  "longdesc",
  "cite",
]);

/** Schemes a hyperlink may keep. Everything else, `javascript:` included, goes. */
const SAFE_LINK_SCHEME = /^(?:https?:|mailto:|#)/i;
/** The only scheme a subresource may keep: inline data the file carries itself. */
const SAFE_EMBEDDED_SCHEME = /^data:(?!text\/html|image\/svg\+xml)/i;

/** Elements whose URL attribute loads a subresource rather than linking out. */
const SUBRESOURCE_TAGS = new Set(["img", "image", "use", "input", "td", "th", "body", "table"]);

function stripDangerousAttributes(element: Element): void {
  const attributes = element.attributes;
  // Indexed, reverse, and skipping elements that carry no attributes at all:
  // this loop runs once per element in the document, and materialising an
  // array per element measured about twice as slow on a multi-megabyte file.
  // Reverse because removing an attribute reindexes the live collection.
  for (let index = attributes.length - 1; index >= 0; index -= 1) {
    const attribute = attributes[index];
    if (!attribute) continue;
    const name = attribute.name.toLowerCase();

    // Every inline event handler, whatever the element.
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      continue;
    }
    // `srcdoc` nests a whole document; there is no safe value for it here.
    if (name === "srcdoc") {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (!URL_ATTRIBUTES.has(name)) continue;

    const value = attribute.value.trim();
    const isSubresource =
      SUBRESOURCE_TAGS.has(element.tagName.toLowerCase()) ||
      name === "srcset" ||
      name === "poster" ||
      name === "background" ||
      name === "ping";

    // A subresource may only be inline `data:`. Anything remote is dropped:
    // it would tell a third party the moment the user opened the file, and a
    // `data:text/html` / `data:image/svg+xml` payload is a document, not an
    // image, so those two are excluded from the allowance.
    const allowed = isSubresource
      ? SAFE_EMBEDDED_SCHEME.test(value)
      : SAFE_LINK_SCHEME.test(value) || SAFE_EMBEDDED_SCHEME.test(value);

    if (!allowed) element.removeAttribute(attribute.name);
  }
}

/**
 * Neutralises remote references inside a `<style>` block or a `style=`
 * attribute. CSS `url()` is a subresource load like any other, and
 * `@import` pulls in a whole remote stylesheet.
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _quote, url: string) =>
      SAFE_EMBEDDED_SCHEME.test(url.trim()) ? match : "none",
    );
}

function sanitizeTree(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (FORBIDDEN_TAGS.has(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }
    if (element.tagName.toLowerCase() === "style") {
      element.textContent = sanitizeCss(element.textContent ?? "");
      continue;
    }
    stripDangerousAttributes(element);
    const inlineStyle = element.getAttribute("style");
    if (inlineStyle) element.setAttribute("style", sanitizeCss(inlineStyle));
  }
}

/**
 * Strip everything executable or outbound from an HTML document and return the
 * result as a document string for a sandboxed frame's `srcdoc`.
 *
 * Returns the document's own markup, so a fragment stays a fragment and a full
 * page keeps its `<head>` styling.
 */
export function sanitizeHtmlDocument(html: string): string {
  if (typeof DOMParser === "undefined") return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  sanitizeTree(parsed);
  return parsed.documentElement?.outerHTML ?? "";
}

/**
 * Strip everything executable or outbound from an SVG document.
 *
 * Returns `null` when the bytes are not an SVG at all (or the parser rejected
 * them), which the renderer turns into an honest "couldn't preview" state
 * rather than handing unknown markup to the DOM.
 */
export function sanitizeSvgDocument(svg: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  // `image/svg+xml` reports a malformed document as a `<parsererror>` root
  // rather than throwing.
  if (parsed.getElementsByTagName("parsererror").length > 0) return null;
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;
  sanitizeTree(parsed);
  stripDangerousAttributes(root);
  return new XMLSerializer().serializeToString(root);
}
