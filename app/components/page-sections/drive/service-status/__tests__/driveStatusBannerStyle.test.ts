import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const banner = readFileSync(join(here, "../DriveStatusBanner.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the drive status banner matches the console's", () => {
  // A flat `warning/10` fill with a matching border reads as a filled
  // alert box and shouts louder than a cancelled plan warrants. The
  // colour belongs in the badge, fading out across the frame.
  it("uses a tinted gradient frame, not a flat fill", () => {
    expect(banner).toContain("bg-gradient-to-r");
    expect(banner).toMatch(/from-warning-50\/\[0\.10\]/);
    expect(banner).not.toMatch(/bg-warning-50\/10\b/);
  });

  it("carries the glow and the solid badge the console uses", () => {
    expect(banner).toMatch(/blur-3xl/);
    expect(banner).toMatch(/badge:\s*"bg-warning-50 text-white"/);
    expect(banner).toMatch(/badge:\s*"bg-primary-50 text-white"/);
  });

  // StatusBanner supports both CTA modes: Overview keeps a right-side
  // primary button (default); Drive passes actionAsButton={false} so the
  // plan-chip Upgrade is not duplicated by a second filled button.
  it("supports a right-side button CTA for Overview", () => {
    expect(banner).toMatch(/actionAsButton/);
    expect(banner).toMatch(/actionAsButton = true/);
    expect(banner).toMatch(/<Button/);
    expect(banner).toMatch(/asLink/);
    expect(banner).toMatch(/variant="primary"/);
    expect(banner).toMatch(/banner\.action/);
  });

  it("Drive uses an underlined text link instead of a button", () => {
    expect(banner).toMatch(/actionAsButton=\{false\}/);
    expect(banner).toMatch(/from "next\/link"/);
    expect(banner).toMatch(/underline underline-offset-2/);
    expect(banner).toMatch(/styles\.action/);
    expect(banner).toMatch(/action:\s*"text-primary-50 hover:text-primary-40"/);
    expect(banner).toMatch(/action:\s*"text-warning-50 hover:text-warning-40"/);
    expect(banner).toMatch(/action:\s*"text-error-50 hover:text-error-40"/);
  });

  // A plan still provisioning resolves on its own, so the badge shows
  // progress rather than the product mark.
  it("spins the badge while a plan is still settling", () => {
    expect(banner).toMatch(/busy \?/);
    expect(banner).toContain("animate-spin");
  });
});

describe("the no-plan banner", () => {
  it("has a danger tone to render in", () => {
    expect(banner).toMatch(/danger:\s*\{/);
    expect(banner).toMatch(/badge:\s*"bg-error-50 text-white"/);
  });

  // The capacity decision is Rust's; the banner must not re-derive it
  // from the auth type or the plan.
  it("reads the capacity source rather than deciding it", () => {
    expect(banner).toContain("overview?.source");
    expect(banner).not.toMatch(/mnemonic|authType/);
  });
});
