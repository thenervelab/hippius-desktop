import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SWIPE_CONTENT } from "../SwipeContent";

const publicDir = path.resolve(__dirname, "../../../../public");
// The sign-in panel was reported to push memory up on Linux, so a new clip
// must stay within what the original clips weighed.
const MAX_GIF_BYTES = 4.5 * 1024 * 1024;

describe("sign-in slides", () => {
  it("are about Drive, one benefit each, in order", () => {
    expect(SWIPE_CONTENT.map((s) => s.title)).toEqual([
      "Distributed Storage",
      "Encrypted on Your Device",
      "Screen Recording",
      "Share & Track",
      "Referrals",
    ]);
  });

  it("no longer advertise compute or staking", () => {
    const text = SWIPE_CONTENT.map((s) => `${s.title} ${s.description}`).join(" ");
    expect(text).not.toMatch(/Confidential Computing|virtual machine|Staking/i);
  });

  it("call the referral reward Account Balance, not credits", () => {
    const referrals = SWIPE_CONTENT.find((s) => s.title === "Referrals");
    expect(referrals?.description).toContain("Account Balance");
    expect(referrals?.description).not.toMatch(/credit/i);
  });

  it.each(SWIPE_CONTENT.map((s) => [s.title, s] as const))(
    "%s has a light and a dark clip that ship with the app",
    (_title, slide) => {
      for (const src of [slide.gif, slide.gifDark]) {
        expect(src).toMatch(/^\/assets\/signin\/\d-(light|dark)\.gif$/);
        const file = path.join(publicDir, src);
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.statSync(file).size).toBeLessThanOrEqual(MAX_GIF_BYTES);
      }
      expect(slide.gif).not.toBe(slide.gifDark);
      expect(slide.durationMs).toBeGreaterThan(0);
    },
  );

  it("ship no clip that no slide uses", () => {
    const used = new Set(SWIPE_CONTENT.flatMap((s) => [s.gif, s.gifDark]));
    const shipped = fs
      .readdirSync(path.join(publicDir, "assets/signin"))
      .filter((f) => f.endsWith(".gif"))
      .map((f) => `/assets/signin/${f}`);
    expect(shipped.sort()).toEqual([...used].sort());
  });
});
