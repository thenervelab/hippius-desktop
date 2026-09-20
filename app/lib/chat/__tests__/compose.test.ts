import { beforeEach, describe, expect, it } from "vitest";

import { applyCompletion, clearDrafts, draftKey, loadDraft, matchingCommands, parseInput, saveDraft, triggerAt } from "@/lib/chat/compose";

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

describe("drafts", () => {
  const ROOM = "!general:hippius.com";
  const ALICE = "@alice:hippius.com";
  const BOB = "@bob:hippius.com";

  beforeEach(() => window.sessionStorage.clear());

  // The webview outlives an account switch and two accounts can share a
  // room, so a room-only key handed one account's unsent text to the next.
  it("a draft is only ever loaded by the user who typed it", () => {
    saveDraft(ALICE, ROOM, null, "private half-written thought");
    expect(loadDraft(ALICE, ROOM, null)).toBe("private half-written thought");
    expect(loadDraft(BOB, ROOM, null)).toBe("");
    expect(loadDraft(null, ROOM, null)).toBe("");
  });

  it("thread drafts are separate from the room draft", () => {
    saveDraft(ALICE, ROOM, null, "in the room");
    saveDraft(ALICE, ROOM, "$root", "in the thread");
    expect(loadDraft(ALICE, ROOM, null)).toBe("in the room");
    expect(loadDraft(ALICE, ROOM, "$root")).toBe("in the thread");
    expect(draftKey(ALICE, ROOM, "$root")).not.toBe(draftKey(ALICE, ROOM, null));
  });

  it("an empty draft removes the entry, and no user id keeps nothing", () => {
    saveDraft(ALICE, ROOM, null, "x");
    saveDraft(ALICE, ROOM, null, "   ");
    expect(window.sessionStorage.getItem(draftKey(ALICE, ROOM, null))).toBeNull();
    saveDraft(null, ROOM, null, "never stored");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("signing out clears every draft of that user and none of another's", () => {
    saveDraft(ALICE, ROOM, null, "alice room");
    saveDraft(ALICE, ROOM, "$root", "alice thread");
    saveDraft(ALICE, "!dm:hippius.com", null, "alice dm");
    saveDraft(BOB, ROOM, null, "bob room");
    window.sessionStorage.setItem("hippius.chat.autoplayGifs", "true");
    clearDrafts(ALICE);
    expect(loadDraft(ALICE, ROOM, null)).toBe("");
    expect(loadDraft(ALICE, ROOM, "$root")).toBe("");
    expect(loadDraft(ALICE, "!dm:hippius.com", null)).toBe("");
    expect(loadDraft(BOB, ROOM, null)).toBe("bob room");
    expect(window.sessionStorage.getItem("hippius.chat.autoplayGifs")).toBe("true");
  });

  it("a user id that is a prefix of another's does not match their drafts", () => {
    saveDraft("@al:hippius.com", ROOM, null, "short");
    saveDraft("@alice:hippius.com", ROOM, null, "long");
    clearDrafts("@al:hippius.com");
    expect(loadDraft("@alice:hippius.com", ROOM, null)).toBe("long");
  });
});
