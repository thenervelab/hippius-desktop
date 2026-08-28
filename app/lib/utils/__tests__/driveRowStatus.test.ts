import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyDriveStatusToRow,
  rowStatusFromDriveStatus,
} from "@/app/lib/utils/driveRowStatus";
import type { DriveEntry } from "@/app/lib/global-atoms/unpinAtoms";
import type { SyncFolder } from "@/app/lib/types/sync-folder";

function row(overrides: Partial<SyncFolder> = {}): SyncFolder {
  return {
    id: "team-drive",
    folderName: "Team Drive",
    localPath: "/Users/me/Team Drive",
    isLocal: true,
    status: "syncing",
    ...overrides,
  };
}

function entry(status: DriveEntry["status"]): DriveEntry {
  return { folderName: "Team Drive", path: "/Users/me/Team Drive", status };
}

describe("rowStatusFromDriveStatus", () => {
  it("maps all three backend variants without collapsing error", () => {
    expect(rowStatusFromDriveStatus({ kind: "active" })).toBe("syncing");
    expect(rowStatusFromDriveStatus({ kind: "paused" })).toBe("paused");
    // The old inline mapping collapsed this into "paused", hiding init
    // failures and revoked shared drives behind a Paused pill.
    expect(
      rowStatusFromDriveStatus({ kind: "error", message: "boom" })
    ).toBe("error");
  });
});

describe("applyDriveStatusToRow", () => {
  it("threads the error message onto the row", () => {
    const updated = applyDriveStatusToRow(
      entry({
        kind: "error",
        message: "Access to this shared drive was removed",
      }),
      row()
    );
    expect(updated.status).toBe("error");
    expect(updated.errorMessage).toBe(
      "Access to this shared drive was removed"
    );
  });

  it("clears a stale error message when the drive recovers", () => {
    const errored = row({ status: "error", errorMessage: "boom" });
    const recovered = applyDriveStatusToRow(entry({ kind: "active" }), errored);
    expect(recovered.status).toBe("syncing");
    expect(recovered.errorMessage).toBeUndefined();
  });

  it("returns the SAME object when nothing changed (render-thrash guard)", () => {
    const syncing = row();
    expect(applyDriveStatusToRow(entry({ kind: "active" }), syncing)).toBe(
      syncing
    );

    const errored = row({ status: "error", errorMessage: "boom" });
    expect(
      applyDriveStatusToRow(entry({ kind: "error", message: "boom" }), errored)
    ).toBe(errored);
  });

  it("leaves the row untouched when the atom has no entry for it", () => {
    const paused = row({ status: "paused" });
    expect(applyDriveStatusToRow(undefined, paused)).toBe(paused);
  });
});

// ── Wiring pins (folderShareWiring.test.ts convention) ────────────────
//
// The resolver being correct is not enough: the bug lived in the two
// components' inline collapses. Pin that BOTH reconciliation effects route
// through the shared resolver and that no inline `kind === "active"`
// collapse survives to reintroduce the divergence.

function densified(relativePath: string): string {
  const source = readFileSync(join(process.cwd(), relativePath), "utf8");
  return source.replace(/\s+/g, "");
}

const COLLAPSE_SITES = [
  "app/components/page-sections/settings/MultiFolderSyncManager.tsx",
  "app/components/page-sections/drive/DriveOnboarding.tsx",
];

describe("drive row status wiring", () => {
  it.each(COLLAPSE_SITES)(
    "%s reconciles rows through applyDriveStatusToRow",
    (file) => {
      const source = densified(file);
      expect(
        source.includes("applyDriveStatusToRow(driveStatuses.get(f.id),f)"),
        `${file} must fold driveStatusesAtom entries through the shared resolver`
      ).toBe(true);
      expect(
        source.includes('kind==="active"?"syncing":"paused"'),
        `${file} must not reintroduce the inline two-state collapse that hid DriveStatus.Error`
      ).toBe(false);
    }
  );
});
