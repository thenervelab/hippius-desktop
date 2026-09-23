import { describe, expect, it } from "vitest";

import { MAX_INLINE_LINE_LENGTH, MAX_SOURCE_LENGTH, renderMarkdown } from "@/lib/chat/markdown";

describe("renderMarkdown", () => {
  it("returns no html for plain text", () => {
    const r = renderMarkdown("just words\nsecond line");
    expect(r.html).toBeNull();
    expect(r.body).toBe("just words\nsecond line");
  });

  it("renders the Slack inline subset", () => {
    expect(renderMarkdown("*bold* _it_ ~gone~ `x<y`").html).toBe(
      "<strong>bold</strong> <em>it</em> <del>gone</del> <code>x&lt;y</code>",
    );
    expect(renderMarkdown("**bold** ~~gone~~").html).toBe("<strong>bold</strong> <del>gone</del>");
  });

  it("does not format inside words, code or urls", () => {
    expect(renderMarkdown("snake_case_name and 2*3*4").html).toBeNull();
    expect(renderMarkdown("`*not bold*`").html).toBe("<code>*not bold*</code>");
    const r = renderMarkdown("see https://x.io/a_b_c?q=1&r=2 now");
    expect(r.html).toBe('see <a href="https://x.io/a_b_c?q=1&amp;r=2">https://x.io/a_b_c?q=1&amp;r=2</a> now');
  });

  it("renders fences, quotes and lists as blocks", () => {
    const r = renderMarkdown("intro\n```ts\nconst a = 1 < 2;\n```\n> quoted\n> more\n- one\n- two\n2. b\n3. c");
    expect(r.html).toBe(
      'intro<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre><blockquote>quoted<br>more</blockquote><ul><li>one</li><li>two</li></ul><ol start="2"><li>b</li><li>c</li></ol>',
    );
  });

  it("turns picked mentions into matrix.to pills and lists them", () => {
    const r = renderMarkdown("hey @Alice Smith and @bob:hippius.com, @room", [
      { userId: "@alice:hippius.com", displayName: "Alice Smith" },
    ]);
    expect(r.html).toBe(
      'hey <a href="https://matrix.to/#/%40alice%3Ahippius.com">Alice Smith</a> and <a href="https://matrix.to/#/%40bob%3Ahippius.com">@bob:hippius.com</a>, @room',
    );
    expect(r.body).toBe("hey Alice Smith and @bob:hippius.com, @room");
    expect(r.mentionedUserIds).toEqual(["@alice:hippius.com", "@bob:hippius.com"]);
    expect(r.mentionsRoom).toBe(true);
  });

  it("does not mention on email-like text", () => {
    const r = renderMarkdown("mail me@example.com please");
    expect(r.html).toBeNull();
    expect(r.mentionedUserIds).toEqual([]);
  });

  describe("bounds", () => {
    it("terminates on fence-like lines that open no fence", () => {
      // Four backticks match no grammar: previously the paragraph loop
      // refused the line and never advanced, hanging the tab.
      expect(renderMarkdown("````").html).toBeNull();
      expect(renderMarkdown("a\n````\nb").html).toBeNull();
      expect(renderMarkdown("```` js\nx\n````").body).toBe("```` js\nx\n````");
    });

    it("accepts an info string with trailing words and an unclosed fence", () => {
      expect(renderMarkdown("```js some words\nlet a;").html).toBe('<pre><code class="language-js">let a;</code></pre>');
      expect(renderMarkdown("```\nopen").html).toBe("<pre><code>open</code></pre>");
    });

    it("skips the parser for drafts above the source cap", () => {
      const huge = `*${"a".repeat(MAX_SOURCE_LENGTH)}*`;
      const r = renderMarkdown(huge, [{ userId: "@x:h", displayName: "X" }]);
      expect(r.html).toBeNull();
      expect(r.body).toBe(huge);
      expect(r.mentionedUserIds).toEqual(["@x:h"]);
    });

    it("escapes without formatting a line above the inline cap", () => {
      const long = `*${"b".repeat(MAX_INLINE_LINE_LENGTH)}* <`;
      expect(renderMarkdown(long).html).toBeNull();
      expect(renderMarkdown(`${long}\n*x*`).html).toBe(`${long.replace("<", "&lt;")}<br><strong>x</strong>`);
    });

    it("stays fast on backtracking-prone input", () => {
      const line = `${"**a ".repeat(900)}${"~b ".repeat(400)}`; // just under the inline cap
      const source = Array.from({ length: 12 }, () => line).join("\n");
      const started = performance.now();
      renderMarkdown(source);
      expect(performance.now() - started).toBeLessThan(500);
    });
  });
});
