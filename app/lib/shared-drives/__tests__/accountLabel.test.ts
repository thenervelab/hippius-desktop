import { describe, expect, it } from "vitest";

import {
  accountDisplayName,
  accountLabelView,
  presentText,
} from "../accountLabel";

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

describe("accountLabelView", () => {
  const ss58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  it("shows the name and keeps the full ss58 and email for the hover", () => {
    const view = accountLabelView(ss58, "Ada", "ada@example.com");
    expect(view.label).toBe("Ada");
    expect(view.isName).toBe(true);
    expect(view.ss58).toBe(ss58);
    expect(view.email).toBe("ada@example.com");
  });

  it("falls back to the shortened ss58 when the keys are absent", () => {
    const view = accountLabelView(ss58);
    expect(view.isName).toBe(false);
    expect(view.label).toContain("…");
    expect(view.label.length).toBeLessThanOrEqual(22);
    expect(view.email).toBeUndefined();
  });

  it("treats blank strings as unknown rather than drawing a gap", () => {
    const view = accountLabelView(ss58, "   ", "  ");
    expect(view.isName).toBe(false);
    expect(view).not.toHaveProperty("email");
  });

  it("never carries a placeholder email to the hover", () => {
    const view = accountLabelView(ss58, "Ada", " user_abc@Hippius.Local ");
    expect(view.label).toBe("Ada");
    expect(view).not.toHaveProperty("email");
  });

  it("honours a tighter width for narrow rows", () => {
    expect(accountLabelView(ss58, undefined, undefined, 14).label.length).toBe(14);
  });
});
