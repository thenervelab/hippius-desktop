// "Active …" counts calendar days in the reader's own time zone, not 24-hour
// blocks: a device used at 23:50 is "yesterday" ten minutes later. Every time
// here is built with the local Date constructor so the cases hold in any zone.

import { describe, expect, it } from "vitest";

import type { AccountDevice } from "@/app/lib/tauri/devices";
import {
  deviceActivityText,
  deviceSubtitle,
  unlinkBody,
  unlinkFailedToast,
  unlinkTitle,
  unlinkedToast,
} from "../deviceCopy";

const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const seconds = (ms: number) => Math.floor(ms / 1000);

const NOW = local(2026, 11, 23, 15, 30);

describe("deviceActivityText", () => {
  it("says today for anything earlier the same day", () => {
    expect(deviceActivityText(seconds(local(2026, 11, 23, 0, 1)), 0, NOW)).toBe("Active today");
    expect(deviceActivityText(seconds(local(2026, 11, 23, 15, 29)), 0, NOW)).toBe("Active today");
  });

  it("says yesterday for the day before, however few minutes ago that was", () => {
    const justAfterMidnight = local(2026, 11, 23, 0, 10);
    expect(deviceActivityText(seconds(local(2026, 11, 22, 23, 50)), 0, justAfterMidnight)).toBe("Active yesterday");
    // And a time later in the day than now, the day before, is still yesterday.
    expect(deviceActivityText(seconds(local(2026, 11, 22, 18, 0)), 0, NOW)).toBe("Active yesterday");
  });

  it("counts days up to six, then names the date", () => {
    expect(deviceActivityText(seconds(local(2026, 11, 21)), 0, NOW)).toBe("Active 2 days ago");
    expect(deviceActivityText(seconds(local(2026, 11, 17, 23, 59)), 0, NOW)).toBe("Active 6 days ago");
    expect(deviceActivityText(seconds(local(2026, 11, 16, 0, 0)), 0, NOW)).toBe("Active 16 Nov 2026");
    expect(deviceActivityText(seconds(local(2026, 11, 3)), 0, NOW)).toBe("Active 3 Nov 2026");
    expect(deviceActivityText(seconds(local(2025, 1, 9)), 0, NOW)).toBe("Active 9 Jan 2025");
  });

  it("falls back to when the device was added when the server has no activity", () => {
    expect(deviceActivityText(0, seconds(local(2026, 11, 3)), NOW)).toBe("Active 3 Nov 2026");
    expect(deviceActivityText(0, seconds(local(2026, 11, 23, 9)), NOW)).toBe("Active today");
  });

  it("reads a date ahead of this clock as today", () => {
    expect(deviceActivityText(seconds(local(2026, 11, 25)), 0, NOW)).toBe("Active today");
  });
});

describe("device copy", () => {
  const device: AccountDevice = {
    deviceId: "a".repeat(32),
    platform: "ios",
    platformName: "iPhone",
    kind: "phone",
    label: "iPhone 15 Pro",
    createdAt: seconds(local(2026, 1, 1)),
    lastActiveAt: seconds(local(2026, 11, 22, 8)),
    isThisDevice: false,
  };

  it("puts the platform before the activity", () => {
    expect(deviceSubtitle(device, NOW)).toBe("iPhone · Active yesterday");
  });

  it("quotes the name with straight quotes, as the app's other toasts do", () => {
    expect(unlinkTitle("Pixel 8")).toBe("Unlink Pixel 8?");
    expect(unlinkedToast("Pixel 8")).toBe('"Pixel 8" unlinked');
    expect(unlinkFailedToast("Pixel 8")).toBe('Couldn\'t unlink "Pixel 8". Try again.');
  });

  it("tells a phone what it loses, a computer that it stops syncing, and anything else that it leaves the list", () => {
    const phone = unlinkBody("phone");
    expect(phone.bullets).toEqual(["Files kept offline on it are deleted from it.", "Camera Uploads stops on it."]);
    expect(phone.closing).toBe(
      "Everything it uploaded stays in your drive. Sign in on it again anytime, and its backup continues where it left off.",
    );
    expect(JSON.stringify(phone)).not.toContain("signed out");
    const computer = unlinkBody("computer");
    expect(computer.bullets).toEqual(["It's signed out the next time it's open and online, and stops syncing."]);
    expect(computer.closing).toBe("Everything it uploaded stays in your drive. Sign in on it again anytime to link it back.");
    expect(unlinkBody("other")).toEqual({
      bullets: [],
      closing: "It's removed from your devices. Everything it uploaded stays in your drive.",
    });
  });
});
