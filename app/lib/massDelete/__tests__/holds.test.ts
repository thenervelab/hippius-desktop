import { describe, it, expect } from "vitest";
import {
  applyCleared,
  applyHeld,
  applyHydration,
  applyRefused,
  applyRestored,
  holdKey,
  updateHold,
  type MassDeleteHolds,
} from "@/app/lib/massDelete/holds";
import type { MassDeleteHold } from "@/app/lib/tauri/massDelete";

const hold = (overrides: Partial<MassDeleteHold> = {}): MassDeleteHold => ({
  label: "Photos",
  side: "server",
  state: "held",
  count: 150,
  syncedCount: 200,
  emptyRoot: false,
  canRestore: true,
  ...overrides,
});

const KEY = holdKey("Photos", "server");

describe("mass delete holds", () => {
  it("keys sides of one drive apart", () => {
    const holds = applyHeld(applyHeld(new Map(), hold()), hold({ side: "local", count: 9 }));
    expect(holds.size).toBe(2);
    expect(holds.get(holdKey("Photos", "local"))?.count).toBe(9);
  });

  it("a new hold event re-raises a dismissed banner and drops an overtaken answer", () => {
    let holds = applyHeld(new Map(), hold());
    holds = updateHold(holds, KEY, { dismissed: true, requested: "remove", notice: "x" });
    holds = applyHeld(holds, hold({ count: 160 }));
    expect(holds.get(KEY)).toMatchObject({
      count: 160,
      dismissed: false,
      requested: null,
      notice: null,
    });
  });

  it("keeps a refusal across the hold hcfs reports right after it", () => {
    let holds = applyHeld(new Map(), hold());
    holds = applyRefused(holds, {
      label: "Photos",
      side: "server",
      reason: "insufficient_space",
      neededBytes: 42,
    });
    holds = applyHeld(holds, hold());
    expect(holds.get(KEY)?.refusal).toEqual({ reason: "insufficient_space", neededBytes: 42 });
  });

  it("a refusal re-raises a dismissed banner and ends the pending restore", () => {
    let holds = applyHeld(new Map(), hold());
    holds = updateHold(holds, KEY, { dismissed: true, requested: "restore" });
    holds = applyRefused(holds, {
      label: "Photos",
      side: "server",
      reason: "insufficient_space",
      neededBytes: null,
    });
    expect(holds.get(KEY)).toMatchObject({ dismissed: false, requested: null });
  });

  it("a restore shows as restoring until the cycle after clears it", () => {
    let holds = applyHeld(new Map(), hold());
    holds = updateHold(holds, KEY, { requested: "restore" });
    holds = applyRestored(holds, { label: "Photos", side: "server" });
    expect(holds.get(KEY)).toMatchObject({ state: "restoring", requested: null });

    holds = applyCleared(holds, { label: "Photos", side: "server" });
    expect(holds.size).toBe(0);
  });

  it("events for a side with no hold change nothing", () => {
    const empty: MassDeleteHolds = new Map();
    expect(applyCleared(empty, { label: "x", side: "local" })).toBe(empty);
    expect(applyRestored(empty, { label: "x", side: "local" })).toBe(empty);
    expect(
      applyRefused(empty, { label: "x", side: "local", reason: "r", neededBytes: null }),
    ).toBe(empty);
    expect(updateHold(empty, "nope", { dismissed: true })).toBe(empty);
  });

  it("hydration replaces the map but keeps an unchanged hold's dismissal", () => {
    let holds = applyHeld(new Map(), hold());
    holds = applyHeld(holds, hold({ label: "Gone" }));
    holds = updateHold(holds, KEY, { dismissed: true });

    holds = applyHydration(holds, [hold({ emptyRoot: true })]);
    expect(holds.size).toBe(1);
    expect(holds.get(KEY)).toMatchObject({ dismissed: true, emptyRoot: true });

    holds = applyHydration(holds, [hold({ count: 151 })]);
    expect(holds.get(KEY)).toMatchObject({ dismissed: false, count: 151 });
  });

  // An event that landed while the read was in flight is newer than the
  // read for its side; the read still fills in every side no event touched.
  it("hydration leaves the sides events touched to the events", () => {
    const LOCAL = holdKey("Photos", "local");
    let holds = applyHeld(new Map(), hold({ count: 160 }));
    holds = applyHydration(
      holds,
      [hold({ count: 150 }), hold({ side: "local", count: 9 }), hold({ label: "Docs" })],
      new Set([KEY, holdKey("Docs", "server")]),
    );
    expect(holds.get(KEY)?.count).toBe(160);
    expect(holds.get(LOCAL)?.count).toBe(9);
    expect(holds.has(holdKey("Docs", "server"))).toBe(false);
  });
});
