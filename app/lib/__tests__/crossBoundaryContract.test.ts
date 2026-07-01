import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getRenameValidationError } from "@/components/page-sections/drive/renameValidation";
import { normalizeRelPath } from "@/lib/utils/relPath";

// These tests pin the two FE validators against the SAME JSON fixtures the Rust
// unit tests consume (src-tauri/sync/files.rs::validate_new_name and
// recent_uploads.rs::normalize_rel_path). The fixture is the single source of
// truth for each cross-boundary contract: if a Rust change drifts the rule, its
// own `cargo test` KAT fails; if a FE change drifts it, this test fails. Neither
// side can move silently without the other, which is the whole point — the FE
// dedups server "last uploads" against the live snapshot by normalized rel-path,
// and the rename dialog must accept exactly what the authoritative Rust command
// accepts.

// vitest runs with cwd at the repo root (where package.json lives), so resolve
// the shared fixtures from there rather than from this file's URL.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(process.cwd(), "src-tauri/tests/fixtures", name), "utf8"));

interface NameCase {
  input: string;
  valid: boolean;
  note: string;
}

interface PathCase {
  input: string;
  expected: string;
  note: string;
}

describe("cross-boundary contract: rename validation (FE ⇔ Rust validate_new_name)", () => {
  const cases = fixture("name_validation_cases.json") as NameCase[];

  it("loads a non-empty shared fixture", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // We assert the VERDICT (accept ⇔ accept), not the message: the FE and Rust
  // word their errors differently and check in a different order by design. A
  // `null` return from getRenameValidationError means "accepted".
  it.each(cases.map((c) => [c.input, c.valid, c.note] as const))(
    "validates %j → valid=%j (%s)",
    (input, valid) => {
      expect(getRenameValidationError(input) === null).toBe(valid);
    },
  );
});

describe("cross-boundary contract: rel-path normalization (FE ⇔ Rust normalize_rel_path)", () => {
  const cases = fixture("path_normalization_cases.json") as PathCase[];

  it("loads a non-empty shared fixture", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.input, c.expected, c.note] as const))(
    "normalizes %j → %j (%s)",
    (input, expected) => {
      expect(normalizeRelPath(input)).toBe(expected);
    },
  );
});
