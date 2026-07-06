import { describe, it, expect } from "vitest";
import {
  EMPTY_SNAPSHOT,
  type SyncSnapshot,
  type FileProgress,
} from "@/app/lib/types/syncSnapshot";
import {
  deriveTrayIconState,
  EMPTY_TRAY_LATCH,
  type TrayLatch,
} from "@/app/lib/tray/trayIconState";

// These tests pin the tray ICON state machine that `startSyncActivityWatcher`
// folds each snapshot through. It used to be inline alongside the (now-removed)
// native menu rows and was only exercised indirectly via menu-label assertions;
// extracting it made the latch / preparing / stalled-completion behaviour
// directly testable.

function snap(overrides: Partial<SyncSnapshot>): SyncSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

function file(overrides: Partial<FileProgress>): FileProgress {
  return {
    path: "a/b.txt",
    fileName: "b.txt",
    label: "drive",
    action: "upload",
    status: "completed",
    progressPercent: 100,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 0,
    ...overrides,
  };
}

describe("deriveTrayIconState — icon selection", () => {
  it("idle/empty snapshot shows the default icon and does not latch", () => {
    const { icon, latch } = deriveTrayIconState(
      EMPTY_SNAPSHOT,
      EMPTY_TRAY_LATCH,
    );
    expect(icon).toBe("default");
    expect(latch.complete).toBe(false);
  });

  it("an in-flight transfer shows the syncing icon", () => {
    const { icon } = deriveTrayIconState(
      snap({
        startedAt: 1000,
        totalFiles: 3,
        completedFiles: 1,
        effectiveInProgress: true,
        files: [file({ status: "inProgress" })],
      }),
      EMPTY_TRAY_LATCH,
    );
    expect(icon).toBe("syncing");
  });

  it("a finished cycle shows the completed icon and latches complete", () => {
    const { icon, latch } = deriveTrayIconState(
      snap({ startedAt: 1000, totalFiles: 2, completedFiles: 2 }),
      EMPTY_TRAY_LATCH,
    );
    expect(icon).toBe("completed");
    expect(latch.complete).toBe(true);
    expect(latch.snapshot?.startedAt).toBe(1000);
  });

  it("a failed cycle uses the default icon (not completed) but still latches", () => {
    const { icon, latch } = deriveTrayIconState(
      snap({ startedAt: 1000, totalFiles: 2, completedFiles: 1, failedFiles: 1 }),
      EMPTY_TRAY_LATCH,
    );
    expect(icon).toBe("default");
    expect(latch.complete).toBe(true);
  });

  it("delete-only activity with no transfer marks the icon completed", () => {
    const { icon } = deriveTrayIconState(
      snap({
        startedAt: 1000,
        totalFiles: 0,
        completedFiles: 0,
        files: [file({ action: "local_delete", status: "completed" })],
      }),
      EMPTY_TRAY_LATCH,
    );
    expect(icon).toBe("completed");
  });
});

describe("deriveTrayIconState — stalled completion", () => {
  it("treats isActive-but-all-done (effectiveInProgress=false) as completed", () => {
    // Engine leaves the raw snapshot active at 100%; effectiveInProgress is the
    // fixup flag the icon must honour instead, otherwise the icon pins on
    // syncing forever.
    const { icon } = deriveTrayIconState(
      snap({
        startedAt: 1000,
        totalFiles: 4,
        completedFiles: 4,
        failedFiles: 0,
        effectiveInProgress: false,
        widgetState: "completed",
      }),
      EMPTY_TRAY_LATCH,
    );
    expect(icon).toBe("completed");
  });
});

describe("deriveTrayIconState — latch persistence and transitions", () => {
  it("keeps the completed icon when the backend resets to an empty cycle", () => {
    const latched: TrayLatch = {
      complete: true,
      snapshot: snap({ startedAt: 1000, totalFiles: 2, completedFiles: 2 }),
    };
    // The post-completion empty frame: nothing active, nothing completed.
    const { icon, latch } = deriveTrayIconState(snap({ startedAt: 1000 }), latched);
    expect(icon).toBe("completed");
    expect(latch.complete).toBe(true);
  });

  it("flips to syncing (and unlatches) when a Finder-add enters 'preparing' after a completion", () => {
    const latched: TrayLatch = {
      complete: true,
      snapshot: snap({ startedAt: 1000, totalFiles: 2, completedFiles: 2 }),
    };
    const { icon, latch } = deriveTrayIconState(
      snap({ widgetState: "preparing", startedAt: null }),
      latched,
    );
    expect(icon).toBe("syncing");
    expect(latch.complete).toBe(false);
  });

  it("unlatches when a genuinely new session with files starts", () => {
    const latched: TrayLatch = {
      complete: true,
      snapshot: snap({ startedAt: 1000, totalFiles: 2, completedFiles: 2 }),
    };
    const { icon, latch } = deriveTrayIconState(
      snap({
        startedAt: 2000,
        totalFiles: 5,
        completedFiles: 0,
        effectiveInProgress: true,
        files: [file({ status: "inProgress" })],
      }),
      latched,
    );
    expect(icon).toBe("syncing");
    expect(latch.complete).toBe(false);
    expect(latch.snapshot).toBeNull();
  });
});

describe("deriveTrayIconState — dedup signature", () => {
  it("produces a stable signature for identical snapshots", () => {
    const s = snap({ startedAt: 1000, totalFiles: 2, completedFiles: 1 });
    const a = deriveTrayIconState(s, EMPTY_TRAY_LATCH);
    const b = deriveTrayIconState(s, EMPTY_TRAY_LATCH);
    expect(a.signature).toBe(b.signature);
  });

  it("changes the signature when progress advances", () => {
    const base = { startedAt: 1000, totalFiles: 4 };
    const a = deriveTrayIconState(snap({ ...base, completedFiles: 1 }), EMPTY_TRAY_LATCH);
    const b = deriveTrayIconState(snap({ ...base, completedFiles: 2 }), EMPTY_TRAY_LATCH);
    expect(a.signature).not.toBe(b.signature);
  });
});
