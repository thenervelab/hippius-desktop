import { describe, expect, it } from "vitest";
import { NEVER_EXPIRES_SECS } from "@/app/components/page-sections/drive/shareDriveModalState";
import { durationWords, expiresInWords, secsUntil, timeLeft, timeLeftWords } from "../timeLeft";

const HOUR = 3600;
const DAY = 24 * HOUR;

describe("durationWords", () => {
  it("rounds up to whole days, so a fresh 7-day invite says 7 days", () => {
    expect(durationWords(7 * DAY - 5)).toBe("7 days");
    expect(durationWords(7 * DAY)).toBe("7 days");
    expect(durationWords(6 * DAY + HOUR)).toBe("7 days");
    expect(durationWords(DAY + 5)).toBe("2 days");
  });

  it("says 1 day only once a day or less is left", () => {
    expect(durationWords(DAY)).toBe("1 day");
    expect(durationWords(DAY - 1)).toBe("24 hours");
  });

  it("rounds up to whole hours under a day", () => {
    expect(durationWords(23 * HOUR + 30 * 60)).toBe("24 hours");
    expect(durationWords(5 * HOUR)).toBe("5 hours");
    expect(durationWords(HOUR + 1)).toBe("2 hours");
    expect(durationWords(HOUR)).toBe("1 hour");
  });

  it("says less than an hour under an hour", () => {
    expect(durationWords(30 * 60)).toBe("less than an hour");
    expect(durationWords(1)).toBe("less than an hour");
  });
});

describe("timeLeft", () => {
  it("sorts expired, never and time left", () => {
    expect(timeLeft(0)).toEqual({ kind: "expired" });
    expect(timeLeft(-10)).toEqual({ kind: "expired" });
    expect(timeLeft(NEVER_EXPIRES_SECS)).toEqual({ kind: "never" });
    expect(timeLeft(NEVER_EXPIRES_SECS - 30 * DAY)).toEqual({ kind: "never" });
    expect(timeLeft(30 * DAY)).toEqual({ kind: "left", words: "30 days" });
  });

  it("words it for a link and for an invite", () => {
    expect(expiresInWords(7 * DAY - 5)).toBe("Expires in 7 days");
    expect(expiresInWords(0)).toBe("Expired");
    expect(expiresInWords(NEVER_EXPIRES_SECS)).toBe("Never expires");
    expect(timeLeftWords(7 * DAY - 5)).toBe("7 days left");
    expect(timeLeftWords(30 * 60)).toBe("less than an hour left");
    expect(timeLeftWords(-1)).toBe("Expired");
    expect(timeLeftWords(NEVER_EXPIRES_SECS)).toBe("Never expires");
  });
});

describe("secsUntil", () => {
  it("counts seconds to a timestamp, or null for an unreadable one", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    expect(secsUntil("2026-09-24T13:00:00Z", now)).toBe(HOUR);
    expect(secsUntil("nope", now)).toBeNull();
  });
});
