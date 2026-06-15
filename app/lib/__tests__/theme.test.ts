import { describe, expect, it } from "vitest";

import {
  THEME_OPTIONS,
  parseStoredThemePreference,
  resolveThemePreference,
} from "../theme";

describe("resolveThemePreference", () => {
  it("forces light regardless of the OS theme", () => {
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("light", false)).toBe("light");
  });

  it("forces dark regardless of the OS theme", () => {
    expect(resolveThemePreference("dark", true)).toBe("dark");
    expect(resolveThemePreference("dark", false)).toBe("dark");
  });

  it("follows the OS theme on system", () => {
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
  });
});

describe("parseStoredThemePreference", () => {
  it("passes valid stored values through", () => {
    expect(parseStoredThemePreference("light")).toBe("light");
    expect(parseStoredThemePreference("dark")).toBe("dark");
    expect(parseStoredThemePreference("system")).toBe("system");
  });

  it("treats a missing key as system", () => {
    expect(parseStoredThemePreference(null)).toBe("system");
  });

  // The key is user-reachable localStorage, so junk (or a value written by
  // a future build with more options) must degrade to system, never throw.
  it("treats unknown values as system", () => {
    expect(parseStoredThemePreference("")).toBe("system");
    expect(parseStoredThemePreference("DARK")).toBe("system");
    expect(parseStoredThemePreference('"dark"')).toBe("system");
    expect(parseStoredThemePreference("auto")).toBe("system");
  });

  it("accepts every settings option, so the picker can never store an unreadable value", () => {
    for (const option of THEME_OPTIONS) {
      expect(parseStoredThemePreference(option.value)).toBe(option.value);
    }
  });
});
