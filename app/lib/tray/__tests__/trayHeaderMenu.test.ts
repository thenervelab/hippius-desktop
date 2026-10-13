import { describe, it, expect } from "vitest";
import type { StorageOverview } from "@/app/lib/hooks/api/useStorageOverview";
import {
  capturesFolderTarget,
  parseTrayPagePayload,
  trayMenuShortcutFor,
  trayPageRoute,
  trayPlanLine,
  trayShortcutLabel,
} from "../trayHeaderMenu";

function overview(change: Partial<StorageOverview> = {}): StorageOverview {
  return {
    usedBytes: 640e9,
    totalBytes: 2e12,
    percent: 32,
    source: "subscription",
    plan: {
      name: "Plus",
      code: "duo",
      amount: 10,
      interval: "month",
      storageBytes: 2e12,
      storageDisplay: "2 TB",
      funding: "credits",
      renewsInDays: 12,
    },
    creditsHip: "12.34",
    freeTierEntitled: true,
    usedPending: false,
    usedDisplay: "640 GB",
    totalDisplay: "2.20 TB",
    freeDisplay: "1.36 TB",
    overDisplay: null,
    planAction: "none",
    canShareDrives: true,
    ...change,
  };
}

describe("the Plan row", () => {
  it("names the plan with Rust's used and the plan's own size", () => {
    // The plan's marketed size, never the effective total (2.20 TB here).
    expect(trayPlanLine(overview())).toBe("Plus · 640 GB / 2 TB");
  });

  it("reads Free with the free tier's total", () => {
    expect(
      trayPlanLine(overview({ source: "free", plan: null, usedDisplay: "0.3 GB", totalDisplay: "10 GB" })),
    ).toBe("Free · 0.3 GB / 10 GB");
  });

  it("says so while Rust's count is catching up, rather than a confident zero", () => {
    expect(trayPlanLine(overview({ usedPending: true, usedDisplay: "0 B" }))).toBe("Plus · Updating…");
  });

  it("says there is no plan for an account with none, and nothing before Rust answers", () => {
    expect(trayPlanLine(overview({ source: "none", plan: null }))).toBe("No storage plan");
    expect(trayPlanLine(null)).toBeNull();
  });
});

describe("the menu's keys", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("are ⌘O, ⌘, and ⌘Q on a Mac", () => {
    expect(trayMenuShortcutFor(key("o", { metaKey: true }), true)).toBe("open");
    expect(trayMenuShortcutFor(key("O", { metaKey: true }), true)).toBe("open");
    expect(trayMenuShortcutFor(key(",", { metaKey: true }), true)).toBe("settings");
    expect(trayMenuShortcutFor(key("q", { metaKey: true }), true)).toBe("quit");
    // Ctrl is not the Mac's command key.
    expect(trayMenuShortcutFor(key("q", { ctrlKey: true }), true)).toBeNull();
  });

  it("are Ctrl+O, Ctrl+, and Ctrl+Q elsewhere", () => {
    expect(trayMenuShortcutFor(key("o", { ctrlKey: true }), false)).toBe("open");
    expect(trayMenuShortcutFor(key(",", { ctrlKey: true }), false)).toBe("settings");
    expect(trayMenuShortcutFor(key("q", { ctrlKey: true }), false)).toBe("quit");
    expect(trayMenuShortcutFor(key("q", { metaKey: true }), false)).toBeNull();
  });

  it("leave every other combination alone", () => {
    expect(trayMenuShortcutFor(key("q"), true)).toBeNull();
    expect(trayMenuShortcutFor(key("o", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(trayMenuShortcutFor(key("q", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(trayMenuShortcutFor(key("f", { metaKey: true }), true)).toBeNull();
  });

  it("are labelled with the platform's own modifier", () => {
    expect(trayShortcutLabel("open", true)).toBe("⌘O");
    expect(trayShortcutLabel("settings", true)).toBe("⌘,");
    expect(trayShortcutLabel("quit", true)).toBe("⌘Q");
    expect(trayShortcutLabel("open", false)).toBe("Ctrl+O");
    expect(trayShortcutLabel("quit", false)).toBe("Ctrl+Q");
  });
});

describe("where the menu goes", () => {
  it("names pages, and the main window maps them to its routes", () => {
    expect(trayPageRoute("plans")).toBe("/drive-plans");
    expect(trayPageRoute("settings")).toBe("/settings");
    expect(trayPageRoute("support")).toBe("/support");
    expect(trayPageRoute("captures")).toBe("/captures");
    expect(trayPageRoute("top-up")).toBeNull();
  });

  it("drops a payload that is not one of those names", () => {
    expect(parseTrayPagePayload({ page: "plans" })).toBe("plans");
    expect(parseTrayPagePayload({ page: "/files" })).toBeNull();
    expect(parseTrayPagePayload({ page: 3 })).toBeNull();
    expect(parseTrayPagePayload("plans")).toBeNull();
    expect(parseTrayPagePayload(null)).toBeNull();
  });

  it("reveals the captures drive's folder when it is on this computer, else opens the Captures page", () => {
    const location = { path: "/Users/me/Documents/Hippius Captures", place: "Documents › Hippius Captures", permissionNote: null };
    expect(
      capturesFolderTarget({ state: "ready", label: "Captures", name: "Captures", remote: false, location }),
    ).toEqual({ kind: "reveal", label: "Captures" });
    expect(
      capturesFolderTarget({ state: "ready", label: "Captures", name: "Captures", remote: true, location: null }),
    ).toEqual({ kind: "page" });
    expect(capturesFolderTarget({ state: "needsSetup", suggested: location, waiting: 0 })).toEqual({ kind: "page" });
    expect(capturesFolderTarget(null)).toEqual({ kind: "page" });
  });
});
