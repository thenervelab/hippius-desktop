// @vitest-environment node

import { describe, expect, it } from "vitest";

import { decodeEntities, htmlToText, plainTextToHtml, sanitizeHtml } from "@/lib/chat/html";

describe("sanitizeHtml", () => {
  it("keeps the Matrix subset and drops scripts with their content", () => {
    const html = '<p>Hi <b>there</b><script>alert(1)</script> <em>friend</em></p>';
    expect(sanitizeHtml(html)).toBe("<p>Hi <b>there</b> <em>friend</em></p>");
  });

  it("drops event handlers, styles and unknown attributes", () => {
    expect(sanitizeHtml('<b onclick="x()" style="color:red" data-foo="1">bold</b>')).toBe("<b>bold</b>");
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">text')).toBe("text");
  });

  it("only allows http(s), mailto and matrix links and adds rel/target", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="https://hippius.com/a?b=1&c=2">x</a>')).toBe(
      '<a href="https://hippius.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(sanitizeHtml('<a href="https://matrix.to/#/@bob:hippius.com">Bob</a>')).toBe(
      '<a href="https://matrix.to/#/@bob:hippius.com" data-mention="true">Bob</a>',
    );
  });

  it("re-escapes text nodes so broken markup cannot open a tag", () => {
    expect(sanitizeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(sanitizeHtml("&lt;script&gt;x&lt;/script&gt;")).toBe("&lt;script&gt;x&lt;/script&gt;");
  });

  it("closes unbalanced tags and strips reply fallbacks", () => {
    expect(sanitizeHtml("<b>bold <i>both</b> tail")).toBe("<b>bold <i>both</i></b> tail");
    expect(sanitizeHtml("<mx-reply><blockquote>quoted</blockquote></mx-reply>reply")).toBe("reply");
  });

  it("keeps code language classes and nothing else", () => {
    expect(sanitizeHtml('<pre><code class="language-rust evil">fn</code></pre>')).toBe("<pre><code>fn</code></pre>");
    expect(sanitizeHtml('<pre><code class="language-rust">fn</code></pre>')).toBe(
      '<pre><code class="language-rust">fn</code></pre>',
    );
  });
});

describe("plain text helpers", () => {
  it("autolinks URLs and escapes the rest", () => {
    expect(plainTextToHtml("see https://hippius.com/x?a=1&b=2. <ok>")).toBe(
      'see <a href="https://hippius.com/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">https://hippius.com/x?a=1&amp;b=2</a>. &lt;ok&gt;',
    );
    expect(plainTextToHtml("a\nb")).toBe("a<br>b");
  });

  it("turns html back into text for previews", () => {
    expect(htmlToText("<mx-reply>x</mx-reply><p>Hello<br>world</p>&amp;")).toBe("Hello\nworld\n&");
  });
});

describe("decodeEntities without a DOM", () => {
  it("decodes the XML five and nbsp, leaves the rest as written", () => {
    expect(decodeEntities("&lt;a&gt; &quot;b&quot; &#39;c&apos; d&nbsp;e &amp;amp;")).toBe("<a> \"b\" 'c' d\u00a0e &amp;");
    expect(decodeEntities("&hellip;")).toBe("&hellip;");
    expect(decodeEntities("no refs")).toBe("no refs");
  });

  it("never throws on a hostile numeric reference", () => {
    for (const input of ["&#99999999999;", "&#xFFFFFFFF;", "&#55296;", "&#-1;", "&#;", "&#x;"]) {
      expect(() => sanitizeHtml(`<p>${input}</p>`)).not.toThrow();
      expect(() => htmlToText(input)).not.toThrow();
    }
  });
});
