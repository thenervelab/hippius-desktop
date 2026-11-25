import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SHARE_TRACK_SLIDE,
  SHARE_TRACK_SLIDE_ENABLED,
  SWIPE_CONTENT,
} from "../SwipeContent";

const repoRoot = path.resolve(__dirname, "../../../..");
const publicDir = path.join(repoRoot, "public");
const parkedClips = path.join(repoRoot, "docs/plans/signin-visuals/clips");
// The sign-in panel was reported to push memory up on Linux, so a clip must
// stay within what the original clips weighed.
const MAX_GIF_BYTES = 4.5 * 1024 * 1024;

describe("sign-in slides", () => {
  it("are about Drive, one benefit each, in order", () => {
    expect(SWIPE_CONTENT.map((s) => s.title)).toEqual([
      "Distributed Storage",
      "Encrypted on Your Device",
      "Screen Recording",
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

  describe("Share & Track, hidden until document links are live everywhere", () => {
    it("is off the carousel while the flag is off", () => {
      expect(SHARE_TRACK_SLIDE_ENABLED).toBe(false);
      expect(SWIPE_CONTENT).not.toContain(SHARE_TRACK_SLIDE);
    });

    it("keeps its clips in the repo, outside the app bundle, ready to come back", () => {
      for (const src of [SHARE_TRACK_SLIDE.gif, SHARE_TRACK_SLIDE.gifDark]) {
        const name = path.basename(src);
        expect(fs.existsSync(path.join(parkedClips, name))).toBe(true);
        expect(fs.existsSync(path.join(publicDir, src))).toBe(false);
      }
    });
  });
});
