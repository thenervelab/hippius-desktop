import { describe, expect, it } from "vitest";

import { EMOJI, emojiForShortcode, isEmojiOnly, replaceShortcodes, searchEmoji } from "@/lib/chat/emoji";

describe("emoji set", () => {
  it("has unique primary names", () => {
    const names = EMOJI.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("resolves shortcodes and aliases", () => {
    expect(emojiForShortcode(":+1:")).toBe("👍");
    expect(emojiForShortcode("thumbsup")).toBe("👍");
    expect(emojiForShortcode("tada")).toBe("🎉");
    expect(emojiForShortcode("nope_not_real")).toBeNull();
  });

  it("replaces shortcodes only at word boundaries", () => {
    expect(replaceShortcodes("ship it :rocket:")).toBe("ship it 🚀");
    expect(replaceShortcodes("time is 12:30:45 ok")).toBe("time is 12:30:45 ok");
    expect(replaceShortcodes(":tada: and :unknown:")).toBe("🎉 and :unknown:");
  });

  it("searches by prefix first, then keywords", () => {
    const results = searchEmoji("thu");
    expect(results[0]?.char).toBe("👍");
    expect(searchEmoji("deploy").some((e) => e.char === "🚀")).toBe(true);
    expect(searchEmoji("").length).toBeGreaterThan(0);
  });

  it("detects emoji-only messages", () => {
    expect(isEmojiOnly("🎉")).toBe(true);
    expect(isEmojiOnly("🎉 🚀 ❤️")).toBe(true);
    expect(isEmojiOnly("🎉🎉🎉🎉")).toBe(false);
    expect(isEmojiOnly("yay 🎉")).toBe(false);
    expect(isEmojiOnly("")).toBe(false);
  });
});
