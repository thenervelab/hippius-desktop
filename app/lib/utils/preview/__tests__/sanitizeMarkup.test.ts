import { describe, expect, it } from "vitest";

import {
  sanitizeCss,
  sanitizeHtmlDocument,
  sanitizeSvgDocument,
} from "@/app/lib/utils/preview/sanitizeMarkup";

/**
 * HTML and SVG are the two formats a synced file can use to run code inside
 * the app's own WebView. The renderers isolate them as well (a `sandbox=""`
 * frame, an inert `<img>`), so these rules are the second of two layers — but
 * they are the layer that does not depend on a WebView honouring an attribute,
 * which is why each one is pinned here.
 */
describe("sanitizeHtmlDocument", () => {
  it("removes script elements, inline and external", () => {
    const out = sanitizeHtmlDocument(
      `<p>hi</p><script>alert(1)</script><script src="https://evil.test/x.js"></script>`,
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("hi");
  });

  it("strips every inline event handler", () => {
    const out = sanitizeHtmlDocument(
      `<div onclick="steal()" onmouseover="x()" ONERROR="y()">t</div>`,
    );
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out.toLowerCase()).not.toContain("onmouseover");
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out).toContain("t");
  });

  it("drops javascript: and data:text/html hrefs but keeps ordinary links", () => {
    const out = sanitizeHtmlDocument(
      `<a href="javascript:alert(1)">a</a>` +
        `<a href="data:text/html,<script>x</script>">b</a>` +
        `<a href="https://example.com">c</a>` +
        `<a href="mailto:x@example.com">d</a>`,
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:text/html");
    expect(out).toContain("https://example.com");
    expect(out).toContain("mailto:x@example.com");
  });

  it("removes elements that embed another document", () => {
    const out = sanitizeHtmlDocument(
      `<iframe src="https://evil.test"></iframe>` +
        `<object data="x.swf"></object><embed src="x">` +
        `<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">` +
        `<link rel="stylesheet" href="https://evil.test/x.css"><form action="https://evil.test"></form>`,
    );
    for (const tag of ["<iframe", "<object", "<embed", "<base", "<meta", "<link", "<form"]) {
      expect(out).not.toContain(tag);
    }
  });

  it("strips srcdoc so a nested document cannot smuggle markup back in", () => {
    const out = sanitizeHtmlDocument(`<div srcdoc="<script>x</script>">t</div>`);
    expect(out).not.toContain("srcdoc");
  });

  it("blocks remote image sources but keeps inline data images", () => {
    // A remote <img> would tell a third party the moment the file is opened.
    const out = sanitizeHtmlDocument(
      `<img src="https://tracker.test/pixel.gif">` +
        `<img src="data:image/png;base64,iVBORw0KGgo=">`,
    );
    expect(out).not.toContain("tracker.test");
    expect(out).toContain("data:image/png");
  });

  it("does not let a data: URL smuggle a document into an image slot", () => {
    const out = sanitizeHtmlDocument(
      `<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">` +
        `<img src="data:text/html,<script>x</script>">`,
    );
    expect(out).not.toContain("data:image/svg+xml");
    expect(out).not.toContain("data:text/html");
  });

  it("keeps styling but neutralises remote CSS references", () => {
    const out = sanitizeHtmlDocument(
      `<style>@import url("https://evil.test/x.css"); body{background:url(https://tracker.test/p.png);color:red}</style>`,
    );
    expect(out).not.toContain("@import");
    expect(out).not.toContain("tracker.test");
    expect(out).toContain("color:red");
  });

  it("sanitises a style attribute the same way as a style element", () => {
    const out = sanitizeHtmlDocument(
      `<div style="background:url(https://tracker.test/p.png);color:blue">t</div>`,
    );
    expect(out).not.toContain("tracker.test");
    expect(out).toContain("color:blue");
  });

  it("returns markup for ordinary content so a real page still renders", () => {
    const out = sanitizeHtmlDocument(
      `<html><head><title>T</title></head><body><h1>Head</h1><p>Body</p></body></html>`,
    );
    expect(out).toContain("Head");
    expect(out).toContain("Body");
  });
});

describe("sanitizeCss", () => {
  it("keeps an inline data: url and drops every remote one", () => {
    expect(sanitizeCss("a{background:url(data:image/png;base64,AAA)}")).toContain("data:image/png");
    expect(sanitizeCss("a{background:url('https://x.test/a.png')}")).toContain("none");
    expect(sanitizeCss("a{background:url(//x.test/a.png)}")).not.toContain("x.test");
  });
});

describe("sanitizeSvgDocument", () => {
  it("removes script from an SVG and returns the rest", () => {
    const out = sanitizeSvgDocument(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>`,
    );
    expect(out).not.toBeNull();
    expect(out).not.toContain("<script");
    expect(out).toContain("<rect");
  });

  it("strips event handlers on the svg root and its children", () => {
    const out = sanitizeSvgDocument(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="5" onclick="x()"/></svg>`,
    );
    expect(out?.toLowerCase()).not.toContain("onload");
    expect(out?.toLowerCase()).not.toContain("onclick");
  });

  it("drops javascript: and remote references", () => {
    const out = sanitizeSvgDocument(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<a xlink:href="javascript:alert(1)"><text>x</text></a>` +
        `<image href="https://tracker.test/p.png"/></svg>`,
    );
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("tracker.test");
  });

  it("removes a foreignObject's embedded frame", () => {
    const out = sanitizeSvgDocument(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe src="https://evil.test"></iframe></foreignObject></svg>`,
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("evil.test");
  });

  it("returns null for bytes that are not an SVG at all", () => {
    // The renderer turns null into an honest error rather than handing
    // unknown markup to the DOM.
    expect(sanitizeSvgDocument("not markup")).toBeNull();
    expect(sanitizeSvgDocument("<html><body>hi</body></html>")).toBeNull();
    expect(sanitizeSvgDocument("<svg><unclosed>")).toBeNull();
  });
});
