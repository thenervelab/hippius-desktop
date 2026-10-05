import { describe, it, expect } from "vitest";
import {
  deviceName,
  progressCopy,
  refusalCopy,
  removeConfirmCopy,
  removeLabel,
  restoredToastCopy,
} from "@/app/lib/massDelete/copy";
import type { MassDeleteHoldView } from "@/app/lib/massDelete/holds";

const view = (overrides: Partial<MassDeleteHoldView> = {}): MassDeleteHoldView => ({
  label: "Photos",
  side: "server",
  state: "held",
  count: 150,
  syncedCount: 200,
  emptyRoot: false,
  canRestore: true,
  title: "150 of 200 files in “Photos” are missing from this Mac",
  body: ["Nothing has been deleted from Hippius yet."],
  dismissed: false,
  requested: null,
  refusal: null,
  notice: null,
  ...overrides,
});

const MAC = deviceName(true);

describe("mass delete copy", () => {
  it("names the device the way Rust's notification does", () => {
    expect(deviceName(true)).toBe("this Mac");
    expect(deviceName(false)).toBe("this computer");
  });

  // The title and lines are Rust's (`hold_text`, unit-tested there); only
  // the buttons around them are written here.
  it("names the Remove button by the side whose copies go", () => {
    expect(removeLabel("server", MAC)).toBe("Remove from Hippius");
    expect(removeLabel("local", MAC)).toBe("Remove from this Mac");
  });

  // Rust groups every count with commas; a German locale writing "1.500"
  // here would put two spellings of one count on the banner.
  it("groups counts the way Rust does, whatever the locale", () => {
    expect(progressCopy(view({ count: 1500, state: "restoring" }))).toBe("Restoring 1,500 files…");
  });

  it("the Remove confirmation states the count, and warns a member", () => {
    const server = removeConfirmCopy(view(), MAC);
    expect(server.title).toBe("Remove 150 files from Hippius?");
    expect(server.confirm).toBe("Remove 150 files");

    const member = removeConfirmCopy(view({ side: "local", canRestore: false }), MAC);
    expect(member.title).toBe("Remove 150 files from this Mac?");
    expect(member.description).toMatch(/shared drive you are a member of/);
    expect(removeConfirmCopy(view({ side: "local" }), MAC).description).not.toMatch(/member/);
  });

  it("shows progress while restoring or after an accepted answer", () => {
    expect(progressCopy(view())).toBeNull();
    expect(progressCopy(view({ state: "restoring" }))).toBe("Restoring 150 files…");
    expect(progressCopy(view({ requested: "restore" }))).toBe("Restoring 150 files…");
    expect(progressCopy(view({ requested: "remove" }))).toBe("Removing 150 files…");
    expect(progressCopy(view({ count: 1, state: "restoring" }))).toBe("Restoring 1 file…");
  });

  // hcfs measures the space on the drive folder's own volume, which may be
  // an external disk rather than the one the device boots from.
  it("an insufficient-space refusal names the disk that holds the folder", () => {
    const text = refusalCopy({ reason: "insufficient_space", neededBytes: 5_000_000_000 });
    expect(text).toMatch(/not enough free space on the disk that holds your Hippius folder/);
    expect(text).not.toMatch(/this Mac/);
    expect(text).toMatch(/5 GB needed/);
    expect(text).toMatch(/Free up space/);
    expect(refusalCopy({ reason: "something_new", neededBytes: null })).toMatch(
      /Nothing has been deleted/,
    );
  });

  it("the restored toast carries the counts", () => {
    const copy = restoredToastCopy("Photos", "server", { restored: 140, pending: 8, skipped: 2 });
    expect(copy.title).toBe("Restored 140 files in “Photos”");
    expect(copy.description).toBe(
      "8 files are still being downloaded. 2 files were left to normal sync.",
    );
    expect(restoredToastCopy("Photos", "local", { restored: 3, pending: 0, skipped: 0 }).description)
      .toBeUndefined();
  });

  it("says one file in the singular", () => {
    const copy = restoredToastCopy("Photos", "local", { restored: 1, pending: 1, skipped: 1 });
    expect(copy.title).toBe("Restored 1 file in “Photos”");
    expect(copy.description).toBe(
      "1 file is still being uploaded. 1 file was left to normal sync.",
    );
  });

  // hcfs reports a restore it applied even when no file finished in that
  // cycle: "Restored 0 files" would read as a failure.
  it("a restore with nothing finished yet says it is restoring", () => {
    const copy = restoredToastCopy("Photos", "server", { restored: 0, pending: 12, skipped: 0 });
    expect(copy.title).toBe("Restoring 12 files in “Photos”…");
    expect(copy.description).toBeUndefined();

    const skippedOnly = restoredToastCopy("Photos", "server", { restored: 0, pending: 0, skipped: 3 });
    expect(skippedOnly.title).not.toMatch(/Restored 0/);
    expect(skippedOnly.description).toBe("3 files were left to normal sync.");
  });
});
