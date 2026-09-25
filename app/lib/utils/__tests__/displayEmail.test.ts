import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { displayEmail, isPlaceholderEmail } from "@/lib/utils/displayEmail";

interface Case {
  input: string;
  shown: string | null;
  note: string;
}

// The same known-answer cases Rust's `display_email` is tested against, so
// neither side can change the rule without the other failing.
const cases = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tests/fixtures/display_email_cases.json"), "utf8"),
) as Case[];

describe("displayEmail", () => {
  it("carries cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)("$note", ({ input, shown }) => {
    expect(displayEmail(input)).toBe(shown ?? undefined);
  });

  it("treats a missing email as absent", () => {
    expect(displayEmail(undefined)).toBeUndefined();
    expect(displayEmail(null)).toBeUndefined();
  });
});

describe("isPlaceholderEmail", () => {
  it("matches only the exact placeholder domain", () => {
    expect(isPlaceholderEmail("user_x@hippius.local")).toBe(true);
    expect(isPlaceholderEmail(" user_x@HIPPIUS.LOCAL ")).toBe(true);
    expect(isPlaceholderEmail("user_x@hippius.localhost")).toBe(false);
    expect(isPlaceholderEmail("hippius.local")).toBe(false);
    expect(isPlaceholderEmail("ada@example.com")).toBe(false);
    expect(isPlaceholderEmail(undefined)).toBe(false);
  });
});
