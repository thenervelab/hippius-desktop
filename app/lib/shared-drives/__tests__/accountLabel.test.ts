import { describe, expect, it } from "vitest";

import { accountDisplayName, presentText } from "../accountLabel";

describe("presentText", () => {
  it("keeps a real value and drops the rest", () => {
    expect(presentText("Ada")).toBe("Ada");
    expect(presentText("  Ada  ")).toBe("Ada");
    expect(presentText("")).toBeUndefined();
    expect(presentText("   ")).toBeUndefined();
    expect(presentText(null)).toBeUndefined();
    expect(presentText(undefined)).toBeUndefined();
  });
});

describe("accountDisplayName", () => {
  const ss58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  it("prefers the name when HCFS sent one", () => {
    expect(accountDisplayName(ss58, "Ada")).toBe("Ada");
  });

  it("falls back to a truncated ss58", () => {
    const label = accountDisplayName(ss58);
    expect(label).toContain("…");
    expect(label.length).toBeLessThanOrEqual(22);
    expect(label.startsWith("5Grw")).toBe(true);
  });
});
