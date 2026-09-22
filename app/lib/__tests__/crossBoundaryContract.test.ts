import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getRenameValidationError } from "@/components/page-sections/drive/renameValidation";
import { normalizeRelPath } from "@/lib/utils/relPath";
import {
  isSearchTermTooShort,
  MIN_SEARCH_TERM_LENGTH,
  serverSearchTerm,
} from "@/lib/utils/searchTerm";

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

interface SearchTermCase {
  input: string;
  sent: string | null;
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

// The rule is enforced in Rust (`classify_query` never puts a short term on the
// wire); the FE copy only picks between "keep typing" and "no results". If the
// two drift, the palette either claims no matches for a term that was never
// searched, or asks for more characters while Rust is already searching.
describe("cross-boundary contract: search term minimum (FE ⇔ Rust classify_query)", () => {
  const cases = fixture("search_term_cases.json") as SearchTermCase[];

  it("loads a non-empty shared fixture", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it("states the server's minimum", () => {
    expect(MIN_SEARCH_TERM_LENGTH).toBe(3);
  });

  it.each(cases.map((c) => [c.input, c.sent, c.note] as const))(
    "sends %j as %j (%s)",
    (input, sent) => {
      expect(serverSearchTerm(input)).toBe(sent);
    },
  );

  it.each(cases.map((c) => [c.input, c.sent, c.note] as const))(
    "hints on %j only when something was typed and nothing is sent (%s)",
    (input, sent) => {
      const typedSomething = input.trim().length > 0;

      expect(isSearchTermTooShort(input)).toBe(typedSomething && sent === null);
    },
  );
});
