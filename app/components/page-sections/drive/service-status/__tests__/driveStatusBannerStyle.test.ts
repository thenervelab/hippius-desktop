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

  // A filled button competes with the page's own actions for the same
  // glance; the banner is telling the user something.
  it("offers its action as a text link", () => {
    expect(banner).toMatch(/underline underline-offset-2/);
    expect(banner).not.toMatch(/<Button/);
  });

  // A plan still provisioning resolves on its own, so the badge shows
  // progress rather than the product mark.
  it("spins the badge while a plan is still settling", () => {
    expect(banner).toMatch(/busy \?/);
    expect(banner).toContain("animate-spin");
  });
});
