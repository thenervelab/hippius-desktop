// Coverage for the pure parts of scripts/dev-env.mjs.
//
// This script rewrites a developer's `src-tauri/.env` in place, so the parsing
// and the rewrite are the two places it can do real damage: a missed key sends
// someone hunting a "data bug" that is really a setup gap, and a careless
// rewrite drops the other vars (HIPPIUS_INDEXER_URL, HIPPIUS_CONSOLE_BASE_URL)
// out of a file that is gitignored and therefore unrecoverable.

import { describe, it, expect } from "vitest";

import { installedEnvCandidates, parseIndexerKey, resolveKey, rewriteEnvText } from "../dev-env.mjs";

describe("parseIndexerKey", () => {
  it("reads the value", () => {
    expect(parseIndexerKey("INDEXER_API_KEY=abc123\n")).toBe("abc123");
  });

  it("treats a missing or blank key as absent", () => {
    expect(parseIndexerKey("")).toBe("");
    expect(parseIndexerKey("# nothing here\nOTHER=1\n")).toBe("");
    // The committed template ships exactly this line; it must not read as a key.
    expect(parseIndexerKey("INDEXER_API_KEY=\n")).toBe("");
  });

  it("ignores a var that merely ends with the name", () => {
    expect(parseIndexerKey("MY_INDEXER_API_KEY=nope\n")).toBe("");
  });

  it("strips a trailing CR so a CRLF file yields a clean key", () => {
    expect(parseIndexerKey("INDEXER_API_KEY=abc123\r\nOTHER=1\r\n")).toBe("abc123");
  });

  it("takes the first of several", () => {
    expect(parseIndexerKey("INDEXER_API_KEY=first\nINDEXER_API_KEY=second\n")).toBe("first");
  });
});

describe("rewriteEnvText", () => {
  it("keeps every other line, including comments", () => {
    const before = "# template header\nHIPPIUS_INDEXER_URL=https://example.test\nINDEXER_API_KEY=\n";

    const after = rewriteEnvText(before, "newkey");

    expect(after).toContain("# template header");
    expect(after).toContain("HIPPIUS_INDEXER_URL=https://example.test");
    expect(parseIndexerKey(after)).toBe("newkey");
  });

  it("leaves exactly one key line even if the file had several", () => {
    const after = rewriteEnvText("INDEXER_API_KEY=one\nOTHER=1\nINDEXER_API_KEY=two\n", "newkey");

    expect(after.split("\n").filter((line) => line.startsWith("INDEXER_API_KEY="))).toEqual(["INDEXER_API_KEY=newkey"]);
    expect(after).toContain("OTHER=1");
  });

  it("writes a single trailing newline, from empty or unterminated input", () => {
    expect(rewriteEnvText("", "k")).toBe("INDEXER_API_KEY=k\n");
    expect(rewriteEnvText("OTHER=1", "k")).toBe("OTHER=1\nINDEXER_API_KEY=k\n");
    expect(rewriteEnvText("OTHER=1\n\n\n", "k")).toBe("OTHER=1\nINDEXER_API_KEY=k\n");
  });
});

describe("resolveKey", () => {
  it("prefers the environment over an installed build", () => {
    const resolved = resolveKey("from-env", [{ path: "/Applications/Hippius.app/…/.env", text: "INDEXER_API_KEY=from-app\n" }]);

    expect(resolved.key).toBe("from-env");
    expect(resolved.sourceDesc).toContain("environment variable");
  });

  it("falls back to the first candidate that carries a key", () => {
    const resolved = resolveKey("", [
      { path: "/first/.env", text: "INDEXER_API_KEY=\n" },
      { path: "/second/.env", text: "INDEXER_API_KEY=from-second\n" },
      { path: "/third/.env", text: "INDEXER_API_KEY=from-third\n" },
    ]);

    expect(resolved).toEqual({ key: "from-second", sourceDesc: "/second/.env" });
  });

  it("reports nothing found when no source has one", () => {
    // The branch that decides between a warning and a failed build. It cannot be
    // exercised end-to-end on a machine with Hippius installed, which is every
    // machine this is likely to be run on.
    expect(resolveKey("", [])).toBeNull();
    expect(resolveKey("", [{ path: "/a/.env", text: "OTHER=1\nINDEXER_API_KEY=\n" }])).toBeNull();
  });
});

describe("installedEnvCandidates", () => {
  it("looks inside the app bundle on macOS", () => {
    const paths = installedEnvCandidates("darwin", { HOME: "/Users/me" });

    expect(paths[0]).toBe("/Applications/Hippius.app/Contents/Resources/.env");
    expect(paths).toContain("/Users/me/Applications/Hippius.app/Contents/Resources/.env");
  });

  it("uses the Windows install roots that are actually set", () => {
    const paths = installedEnvCandidates("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });

    // Only the defined roots are probed — an undefined PROGRAMFILES must not
    // become a path rooted at "undefined".
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("Hippius");
    expect(paths.join()).not.toContain("undefined");
  });

  it("falls back to the Linux package layout", () => {
    expect(installedEnvCandidates("linux", {})).toContain("/usr/lib/Hippius/.env");
  });
});
