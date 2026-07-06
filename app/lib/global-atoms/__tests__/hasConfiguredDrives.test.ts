import { describe, it, expect } from "vitest";
import { createStore } from "jotai";
import {
  hasConfiguredDrivesAtom,
  driveStatusesAtom,
  driveStatusesLoadedAtom,
  type DriveEntry,
} from "@/app/lib/global-atoms/unpinAtoms";

// hasConfiguredDrivesAtom gates the "set up sync first" dialog and the upload
// buttons' toast. The sign of its cold-start branch matters in BOTH directions:
// returning false before the first fetch flashes the setup dialog on every page
// load; returning true after a confirmed-empty load lets uploads bypass the
// gate. Drive it through a real jotai store rather than re-deriving the logic.

const entry = (status: DriveEntry["status"]): DriveEntry => ({
  folderName: "Hippius",
  path: "/Users/me/Hippius",
  status,
});

describe("hasConfiguredDrivesAtom", () => {
  it("returns true on cold start (not yet loaded) so the setup dialog doesn't flash", () => {
    const store = createStore();
    // Default: driveStatusesLoadedAtom = false, map empty.
    expect(store.get(driveStatusesLoadedAtom)).toBe(false);
    expect(store.get(hasConfiguredDrivesAtom)).toBe(true);
  });

  it("returns false only after a completed load with an empty map", () => {
    const store = createStore();
    store.set(driveStatusesLoadedAtom, true);
    expect(store.get(hasConfiguredDrivesAtom)).toBe(false);
  });

  it("returns true once loaded with at least one drive", () => {
    const store = createStore();
    store.set(driveStatusesLoadedAtom, true);
    store.set(driveStatusesAtom, new Map([["default", entry({ kind: "active" })]]));
    expect(store.get(hasConfiguredDrivesAtom)).toBe(true);
  });

  it("counts a paused drive as configured", () => {
    const store = createStore();
    store.set(driveStatusesLoadedAtom, true);
    store.set(driveStatusesAtom, new Map([["photos", entry({ kind: "paused" })]]));
    expect(store.get(hasConfiguredDrivesAtom)).toBe(true);
  });

  it("flips back to false if the last drive is removed after load", () => {
    const store = createStore();
    store.set(driveStatusesLoadedAtom, true);
    store.set(driveStatusesAtom, new Map([["default", entry({ kind: "active" })]]));
    expect(store.get(hasConfiguredDrivesAtom)).toBe(true);

    store.set(driveStatusesAtom, new Map());
    expect(store.get(hasConfiguredDrivesAtom)).toBe(false);
  });
});
