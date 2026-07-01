import { describe, expect, it } from "vitest";
import { normalizeRelPath } from "../relPath";

describe("normalizeRelPath", () => {
  it("strips a single leading slash", () => {
    expect(normalizeRelPath("/Docs/a.png")).toBe("Docs/a.png");
  });

  it("strips multiple leading slashes", () => {
    expect(normalizeRelPath("//Docs//a.png")).toBe("Docs//a.png");
  });

  it("leaves an already-normalized path unchanged (idempotent)", () => {
    const once = normalizeRelPath("Docs/a.png");
    expect(once).toBe("Docs/a.png");
    expect(normalizeRelPath(once)).toBe("Docs/a.png");
  });

  it("does not touch interior or trailing slashes", () => {
    expect(normalizeRelPath("a/b/")).toBe("a/b/");
  });

  it("handles the empty string", () => {
    expect(normalizeRelPath("")).toBe("");
  });

  it("makes the snapshot side (leading slash) match the server side", () => {
    // The concrete divergence the helper exists to close: hcfs snapshot paths
    // can carry a leading slash; the server mapper trims it.
    expect(normalizeRelPath("/report.pdf")).toBe(normalizeRelPath("report.pdf"));
  });
});
