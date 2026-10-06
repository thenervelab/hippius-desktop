import { describe, it, expect } from "vitest";
import {
  applyCleared,
  applyHeld,
  applyHydration,
  updateDrive,
  type EmptyRemoteDrives,
} from "@/app/lib/emptyRemote/drives";
import type { EmptyRemoteDrive } from "@/app/lib/tauri/emptyRemote";

const drive = (fields: Partial<EmptyRemoteDrive> = {}): EmptyRemoteDrive => ({
  label: "Photos",
  syncedCount: 12,
  canConfirm: true,
  title: "t",
  body: ["b"],
  ...fields,
});

const held = (...drives: EmptyRemoteDrive[]): EmptyRemoteDrives =>
  drives.reduce((map, d) => applyHeld(map, d), new Map() as EmptyRemoteDrives);

describe("empty-drive prompt state", () => {
  it("a new report re-raises a put-away banner and drops a confirmation it overtook", () => {
    const answered = updateDrive(held(drive()), "Photos", { dismissed: true, confirming: true });
    const next = applyHeld(answered, drive({ syncedCount: 15 }));
    expect(next.get("Photos")).toMatchObject({ dismissed: false, confirming: false, syncedCount: 15 });
  });

  it("a clear removes only that drive", () => {
    const next = applyCleared(held(drive(), drive({ label: "Docs" })), "Photos");
    expect([...next.keys()]).toEqual(["Docs"]);
  });

  it("hydration keeps the presentation of an unchanged prompt", () => {
    const put = updateDrive(held(drive()), "Photos", { dismissed: true });
    expect(applyHydration(put, [drive()]).get("Photos")?.dismissed).toBe(true);
    expect(applyHydration(put, [drive({ syncedCount: 13 })]).get("Photos")?.dismissed).toBe(false);
    expect(applyHydration(put, []).size).toBe(0);
  });

  it("a drive an event changed during the read keeps what the event made of it", () => {
    // The event cleared Photos after the read began; the read still has it.
    const cleared = applyCleared(held(drive()), "Photos");
    const next = applyHydration(cleared, [drive(), drive({ label: "Docs" })], new Set(["Photos"]));
    expect([...next.keys()]).toEqual(["Docs"]);
  });
});
