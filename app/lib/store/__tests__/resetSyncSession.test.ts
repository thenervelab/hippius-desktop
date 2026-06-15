import { describe, it, expect, beforeEach } from "vitest";
import { appStore } from "@/lib/store/jotaiStore";
import { resetSyncSession } from "@/lib/store/resetSyncSession";
import {
  pendingConflictsAtom,
  failedFilesAtom,
  creditsExhaustedAtom,
  syncEngineHealthAtom,
  DEFAULT_SYNC_ENGINE_HEALTH,
} from "@/lib/store/syncAtoms";
import {
  driveStatusesAtom,
  driveStatusesLoadedAtom,
  metadataStaleLabelsAtom,
  syncRequiresReauthAtom,
} from "@/lib/global-atoms/unpinAtoms";
import type { StagedChanges } from "@/lib/types/syncTypes";

describe("resetSyncSession", () => {
  // appStore is a module-level singleton; clear it before each case so a
  // previous test's seed can't mask a missing reset.
  beforeEach(() => resetSyncSession());

  it("clears every session-scoped sync atom so account A cannot leak into the next login", () => {
    // Seed account A's session state across all the leak-prone atoms.
    appStore.set(
      pendingConflictsAtom,
      new Map([
        [
          "a",
          { uploads: [], downloads: [], conflicts: [] } as unknown as StagedChanges,
        ],
      ])
    );
    appStore.set(failedFilesAtom, [
      { label: "a", path: "/a/p", fileName: "p", error: "boom", failureCount: 5 },
    ]);
    appStore.set(creditsExhaustedAtom, { label: "a", balanceCents: 0, requiredCents: 100, fileCount: 3 });
    appStore.set(syncEngineHealthAtom, {
      ...DEFAULT_SYNC_ENGINE_HEALTH,
      status: "server_unreachable",
      consecutive_failures: 4,
    });
    appStore.set(
      driveStatusesAtom,
      new Map([["a", { folderName: "A", path: "/a", status: { kind: "active" } }]])
    );
    appStore.set(driveStatusesLoadedAtom, true);
    appStore.set(metadataStaleLabelsAtom, new Map([["a", "stale"]]));
    appStore.set(syncRequiresReauthAtom, true);

    resetSyncSession();

    // pendingConflictsAtom is keyed by drive label, so "empty" is a 0-size Map.
    expect(appStore.get(pendingConflictsAtom).size).toBe(0);
    expect(appStore.get(failedFilesAtom)).toBeNull();
    expect(appStore.get(creditsExhaustedAtom)).toBeNull();
    expect(appStore.get(syncEngineHealthAtom)).toEqual(DEFAULT_SYNC_ENGINE_HEALTH);
    expect(appStore.get(driveStatusesAtom).size).toBe(0);
    expect(appStore.get(driveStatusesLoadedAtom)).toBe(false);
    expect(appStore.get(metadataStaleLabelsAtom).size).toBe(0);
    expect(appStore.get(syncRequiresReauthAtom)).toBe(false);
  });

  it("resets the driveStatusesLoaded latch so hasConfiguredDrives returns to its cold-start state (F18)", () => {
    // Previous account finished loading an empty map; without the reset the
    // next login would evaluate hasConfiguredDrives against loaded=true + the
    // stale map instead of the loading -> treat-as-configured contract.
    appStore.set(driveStatusesAtom, new Map());
    appStore.set(driveStatusesLoadedAtom, true);

    resetSyncSession();

    expect(appStore.get(driveStatusesLoadedAtom)).toBe(false);
  });
});
