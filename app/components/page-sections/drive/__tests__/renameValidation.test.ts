import { describe, expect, it } from "vitest";

import {
  basenameOf,
  extensionOf,
  getRenameValidationError,
  isUnchangedName,
  wouldChangeExtension,
} from "../renameValidation";

describe("basenameOf", () => {
  it("returns the final component for nested relative paths", () => {
    expect(basenameOf("docs/reports/q3.pdf")).toBe("q3.pdf");
    expect(basenameOf("docs\\reports\\q3.pdf")).toBe("q3.pdf");
    expect(basenameOf("plain.txt")).toBe("plain.txt");
  });
});

describe("extensionOf", () => {
  it("lowercases and handles dotfiles as extensionless", () => {
    expect(extensionOf("Report.PDF")).toBe("pdf");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("no-extension")).toBe("");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });
});

describe("getRenameValidationError", () => {
  it("accepts ordinary names including unicode", () => {
    expect(getRenameValidationError("notes.txt")).toBeNull();
    expect(getRenameValidationError("üñïçødé 文件.pdf")).toBeNull();
  });

  it("rejects empty, whitespace-only, traversal, and separator names", () => {
    expect(getRenameValidationError("")).not.toBeNull();
    expect(getRenameValidationError("   ")).not.toBeNull();
    expect(getRenameValidationError(".")).not.toBeNull();
    expect(getRenameValidationError("..")).not.toBeNull();
    expect(getRenameValidationError("a/b")).not.toBeNull();
    expect(getRenameValidationError("a\\b")).not.toBeNull();
  });

  it("rejects Windows-unsafe shapes and reserved device names", () => {
    expect(getRenameValidationError("a:b")).not.toBeNull();
    expect(getRenameValidationError("name.")).not.toBeNull();
    expect(getRenameValidationError("CON")).not.toBeNull();
    expect(getRenameValidationError("con.txt")).not.toBeNull();
    expect(getRenameValidationError("Nul")).not.toBeNull();
    expect(getRenameValidationError("lpt9.log")).not.toBeNull();
    // Near-misses stay legal.
    expect(getRenameValidationError("console.txt")).toBeNull();
    expect(getRenameValidationError("LPT10")).toBeNull();
    expect(getRenameValidationError("aux-cable.jpg")).toBeNull();
  });

  it("enforces the 255-byte limit in bytes, not characters", () => {
    // é is 2 UTF-8 bytes: 127 of them + "a" = 255 bytes (ok), 128 = 256 (too long).
    expect(getRenameValidationError("é".repeat(127) + "a")).toBeNull();
    expect(getRenameValidationError("é".repeat(128))).not.toBeNull();
  });
});

describe("isUnchangedName", () => {
  it("treats trimmed equality as unchanged", () => {
    expect(isUnchangedName(" a.txt ", "a.txt")).toBe(true);
    expect(isUnchangedName("b.txt", "a.txt")).toBe(false);
    // Case-only renames ARE a change (legal on-disk rename).
    expect(isUnchangedName("A.txt", "a.txt")).toBe(false);
  });
});

describe("wouldChangeExtension", () => {
  it("flags extension changes for files only", () => {
    expect(wouldChangeExtension("a.pdf", "a.txt", false)).toBe(true);
    expect(wouldChangeExtension("b.txt", "a.txt", false)).toBe(false);
    expect(wouldChangeExtension("b.TXT", "a.txt", false)).toBe(false);
    expect(wouldChangeExtension("a", "a.txt", false)).toBe(true);
    // Folders have no extension semantics — "v2.0" is a fine folder name.
    expect(wouldChangeExtension("v2.0", "photos", true)).toBe(false);
  });
});
