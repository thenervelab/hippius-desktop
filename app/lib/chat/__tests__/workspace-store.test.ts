// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isPlausibleJoinToken,
  loadActiveWorkspace,
  loadCollapsedCategories,
  parseJoinInput,
  resolveActiveWorkspace,
  saveActiveWorkspace,
  saveCollapsedCategories,
} from "@/lib/chat/workspace-store";

// One fake `window.localStorage` for the whole file: `vi.stubGlobal` in two
// describe bodies would leave only the last stub standing.
const store = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
vi.stubGlobal("window", { localStorage });
afterEach(() => store.clear());

describe("collapsed categories", () => {
  it("round-trips per account and workspace, and removes the key when nothing is collapsed", () => {
    saveCollapsedCategories("@me:hippius.com", "!acme", new Set(["!eng", "!design"]));
    expect(loadCollapsedCategories("@me:hippius.com", "!acme")).toEqual(new Set(["!eng", "!design"]));
    expect(loadCollapsedCategories("@me:hippius.com", "!other")).toEqual(new Set());
    expect(loadCollapsedCategories("@you:hippius.com", "!acme")).toEqual(new Set());
    expect([...store.keys()]).toEqual(["hippius-chat-collapsed-categories:@me:hippius.com:!acme"]);
    saveCollapsedCategories("@me:hippius.com", "!acme", new Set());
    expect(store.size).toBe(0);
  });

  it("ignores garbage in storage", () => {
    store.set("hippius-chat-collapsed-categories:@me:hippius.com:!acme", "{not json");
    expect(loadCollapsedCategories("@me:hippius.com", "!acme")).toEqual(new Set());
    store.set("hippius-chat-collapsed-categories:@me:hippius.com:!acme", JSON.stringify([1, "nope", "!ok"]));
    expect(loadCollapsedCategories("@me:hippius.com", "!acme")).toEqual(new Set(["!ok"]));
  });
});

describe("resolveActiveWorkspace", () => {
  const available = [{ id: "!a" }, { id: "!b" }];

  it("reopens the remembered workspace when it is still joined", () => {
    expect(resolveActiveWorkspace("!b", available)).toBe("!b");
  });

  it("falls back to the first workspace when the remembered one is gone", () => {
    expect(resolveActiveWorkspace("!gone", available)).toBe("!a");
    expect(resolveActiveWorkspace(null, available)).toBe("!a");
  });

  it("is null with no workspaces (onboarding)", () => {
    expect(resolveActiveWorkspace("!a", [])).toBeNull();
  });
});

describe("join tokens", () => {
  it("accepts url-safe tokens and rejects anything else", () => {
    expect(isPlausibleJoinToken("abcDEF123_-xyz")).toBe(true);
    expect(isPlausibleJoinToken("short")).toBe(false);
    expect(isPlausibleJoinToken("has space here")).toBe(false);
    expect(isPlausibleJoinToken("../../etc")).toBe(false);
  });

  it("reads a pasted token, or the token out of a console invite link", () => {
    expect(parseJoinInput("  tok_en-123456 ")).toBe("tok_en-123456");
    expect(parseJoinInput("https://console.hippius.com/chat/join/tok_en-123456")).toBe("tok_en-123456");
    expect(parseJoinInput("https://console.hippius.com/chat/join/tok%5Fen-123456?x=1")).toBe("tok_en-123456");
    expect(parseJoinInput("https://console.hippius.com/chat/join/")).toBeNull();
    expect(parseJoinInput("https://console.hippius.com/dashboard")).toBeNull();
    expect(parseJoinInput("not a token")).toBeNull();
    expect(parseJoinInput("")).toBeNull();
  });
});

describe("active workspace", () => {
  it("remembers the workspace per account and forgets it on null", () => {
    saveActiveWorkspace("@me:hippius.com", "!acme");
    expect(loadActiveWorkspace("@me:hippius.com")).toBe("!acme");
    expect(loadActiveWorkspace("@you:hippius.com")).toBeNull();
    saveActiveWorkspace("@me:hippius.com", null);
    expect(loadActiveWorkspace("@me:hippius.com")).toBeNull();
  });

  it("ignores a stored value that is not a room id", () => {
    store.set("hippius-chat-workspace:@me:hippius.com", "garbage");
    expect(loadActiveWorkspace("@me:hippius.com")).toBeNull();
  });
});
