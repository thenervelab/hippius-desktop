import { describe, expect, it } from "vitest";

import { getTrayProgressText } from "../trayProgressText";
import {
  makeFileProgress,
  makeSnapshot,
} from "@/app/lib/test-utils/syncSnapshotFactory";
import type { SyncSnapshot } from "@/app/lib/types/syncSnapshot";

/** Build the input for an actively-syncing snapshot (the common case). */
function activeInput(snapshot: SyncSnapshot) {
  return {
    progress: snapshot,
    effectiveSnapshot: snapshot,
    isActive: true,
    latchedComplete: false,
    effectiveCompleted: false,
  };
}

/** Build the input for a settled (completed/failed) snapshot. */
function completedInput(snapshot: SyncSnapshot) {
  return {
    progress: snapshot,
    effectiveSnapshot: snapshot,
    isActive: false,
    latchedComplete: true,
    effectiveCompleted: true,
  };
}

describe("getTrayProgressText – in progress", () => {
  it("shows the real single-count total, NOT the doubled combined total", () => {
    // The same regression as the sidebar widget: a 162 MB upload must read
    // 162 MB, not the 324 MB encrypt+transfer combined total. This pins the
    // tray to the shared selectLiveTransferBytes selector.
    const snapshot = makeSnapshot([
      makeFileProgress("big.dmg", {
        status: "inProgress",
        progressPercent: 50,
        totalBytes: 162_000_000,
        bytesEncrypted: 162_000_000,
        bytesTransferred: 81_000_000,
      }),
    ]);
    expect(snapshot.combinedBytesExpected).toBe(324_000_000);

    const { sizeText } = getTrayProgressText(activeInput(snapshot));
    expect(sizeText).toBe("81 MB / 162 MB");
  });

  it("counts synced files against the total", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("done.txt", { status: "completed", totalBytes: 100 }),
      makeFileProgress("now.bin", {
        status: "inProgress",
        progressPercent: 40,
        totalBytes: 1000,
        bytesTransferred: 400,
      }),
      makeFileProgress("next.bin", { status: "pending", totalBytes: 500 }),
    ]);

    const { progressText } = getTrayProgressText(activeInput(snapshot));
    expect(progressText).toBe("1 of 3 files synced");
  });

  it("uses singular wording for a single file", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("solo.bin", {
        status: "inProgress",
        progressPercent: 10,
        totalBytes: 1000,
        bytesTransferred: 100,
      }),
    ]);

    const { progressText } = getTrayProgressText(activeInput(snapshot));
    expect(progressText).toBe("0 of 1 file synced");
  });

  it("shows 'pending' before any byte or file has moved", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("a.bin", { status: "pending", totalBytes: 0 }),
      makeFileProgress("b.bin", { status: "pending", totalBytes: 0 }),
    ]);

    const { progressText, sizeText } = getTrayProgressText(activeInput(snapshot));
    expect(progressText).toBe("2 files pending");
    // No byte total known yet (totalBytes 0) → no size line.
    expect(sizeText).toBeNull();
  });
});

describe("getTrayProgressText – settled", () => {
  it("reports failure counts when files failed", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("ok.txt", { status: "completed", totalBytes: 100 }),
      makeFileProgress("bad.txt", { status: "error", totalBytes: 200 }),
    ]);

    const { progressText, sizeText } = getTrayProgressText(
      completedInput(snapshot),
    );
    expect(progressText).toBe("1 of 2 files failed");
    // Failed bytes count toward expected but not progress: 100 / 300.
    expect(sizeText).toBe("100 B / 300 B");
  });

  it("reports a successful sync with the final total only", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("a.txt", { status: "completed", totalBytes: 1_000_000 }),
      makeFileProgress("b.txt", { status: "completed", totalBytes: 1_000_000 }),
    ]);

    const { progressText, sizeText } = getTrayProgressText(
      completedInput(snapshot),
    );
    expect(progressText).toBe("2 of 2 files synced");
    expect(sizeText).toBe("2 MB");
  });

  it("reports a delete-only session", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("gone.txt", {
        status: "completed",
        action: "remote_delete",
        totalBytes: 0,
      }),
    ]);

    const { progressText } = getTrayProgressText(completedInput(snapshot));
    expect(progressText).toBe("1 file deleted");
  });

  it("reports a mixed synced + deleted session", () => {
    const snapshot = makeSnapshot([
      makeFileProgress("kept.txt", { status: "completed", totalBytes: 100 }),
      makeFileProgress("gone.txt", {
        status: "completed",
        action: "local_delete",
        totalBytes: 0,
      }),
    ]);

    const { progressText } = getTrayProgressText(completedInput(snapshot));
    expect(progressText).toBe("1 synced · 1 deleted");
  });
});
