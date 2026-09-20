import { describe, expect, it } from "vitest";

import { applyCompletion, matchingCommands, parseInput, triggerAt } from "@/lib/chat/compose";

describe("slash commands", () => {
  it("parses known commands, unknown ones and escaped slashes", () => {
    expect(parseInput("/me waves at everyone")).toEqual({ kind: "command", name: "me", args: "waves at everyone" });
    expect(parseInput("/leave")).toEqual({ kind: "command", name: "leave", args: "" });
    expect(parseInput("/nope x")).toEqual({ kind: "unknown-command", name: "nope" });
    expect(parseInput("//literal")).toEqual({ kind: "text", text: "/literal" });
    expect(parseInput("plain /me")).toEqual({ kind: "text", text: "plain /me" });
  });

  it("filters commands by prefix", () => {
    expect(matchingCommands("/m").map((c) => c.name)).toEqual(["me", "mute"]);
    expect(matchingCommands("")).toHaveLength(11);
    expect(matchingCommands("/gi").map((c) => c.name)).toEqual(["gif"]);
  });

  it("parses /gif with and without a search", () => {
    expect(parseInput("/gif high five")).toEqual({ kind: "command", name: "gif", args: "high five" });
    expect(parseInput("/gif")).toEqual({ kind: "command", name: "gif", args: "" });
  });
});

describe("autocomplete triggers", () => {
  it("detects mention, emoji and command triggers at the caret", () => {
    expect(triggerAt("hey @al", 7)).toEqual({ kind: "mention", query: "al", start: 4 });
    expect(triggerAt("ship :rock", 10)).toEqual({ kind: "emoji", query: "rock", start: 5 });
    expect(triggerAt("/inv", 4)).toEqual({ kind: "command", query: "inv", start: 0 });
    expect(triggerAt("email me@x.io", 13)).toBeNull();
    expect(triggerAt("time 12:3", 9)).toBeNull();
    expect(triggerAt("not /cmd", 8)).toBeNull();
  });

  it("applies a completion and moves the caret", () => {
    const r = applyCompletion("hey @al there", 4, 7, "@Alice");
    expect(r.text).toBe("hey @Alice  there");
    expect(r.caret).toBe(11);
  });
});
