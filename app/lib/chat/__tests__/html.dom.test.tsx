// Runs under jsdom (the `.tsx` project) to exercise the DOM decoding path;
// `html.test.ts` covers the no-DOM fallback.
import { describe, expect, it } from "vitest";

import { decodeEntities, htmlToText, sanitizeHtml } from "@/lib/chat/html";

describe("decodeEntities with a DOM", () => {
  it("decodes named, decimal and hex references", () => {
    expect(decodeEntities("&hellip; &eacute; &#128512; &#x1F600; &amp;lt;")).toBe("\u2026 \u00e9 \u{1F600} \u{1F600} &lt;");
  });

  it("maps out-of-range and surrogate code points to U+FFFD instead of throwing", () => {
    expect(decodeEntities("&#99999999999;")).toBe("\uFFFD");
    expect(decodeEntities("&#xFFFFFFFF;")).toBe("\uFFFD");
    expect(decodeEntities("&#55296;")).toBe("\uFFFD");
    expect(decodeEntities("&#0;")).toBe("\uFFFD");
    expect(decodeEntities("&#;&#x;&#-1;")).toBe("&#;&#x;&#-1;");
  });

  it("cannot open an element or a comment from a text run", () => {
    expect(decodeEntities("<img src=x onerror=alert(1)> &lt;b&gt; <!-- c -->")).toBe("<img src=x onerror=alert(1)> <b> <!-- c -->");
  });

  it("feeds the sanitiser and the preview helper", () => {
    expect(sanitizeHtml("<p>&#99999999999; &hellip; &lt;script&gt;</p>")).toBe("<p>\uFFFD \u2026 &lt;script&gt;</p>");
    expect(sanitizeHtml('<a href="https://h.io/?a=1&amp;b=&#50;">x</a>')).toBe(
      '<a href="https://h.io/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(htmlToText("<p>&#99999999999;&nbsp;&rarr;</p>")).toBe("\uFFFD\u00a0\u2192");
  });
});
