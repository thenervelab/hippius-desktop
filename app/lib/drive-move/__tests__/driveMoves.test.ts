import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveItemResult } from "../moveLogic";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { cancelDriveMove, listMoveDestinations, moveBetweenDrives, movedToDriveMessage, runDriveMove, type DriveMoveOutcome, type DriveMoveRequest } from "../driveMoves";

const base = { jobId: "job-1", sourceLabel: "Main", destLabel: "shared:5Owner~abc", destination: "Inbox" };
const items = [
  { path: "a.txt", isFolder: false, name: "a.txt" },
  { path: "Trip", isFolder: true, name: "Trip" },
];

const result = (path: string, status: MoveItemResult["status"]): MoveItemResult => ({
  path,
  isFolder: path === "Trip",
  status,
  newPath: status === "moved" ? `Inbox/${path}` : null,
  message: null,
  clashIsFolder: false,
  replaced: false,
});

const outcome = (over: Partial<DriveMoveOutcome> = {}): DriveMoveOutcome => ({
  results: [],
  confirm: null,
  revoked: null,
  cancelled: false,
  ready: false,
  ...over,
});

function hooks(over: Partial<Parameters<typeof runDriveMove>[3]> = {}) {
  return {
    askClashes: vi.fn().mockResolvedValue(null),
    confirmSharing: vi.fn().mockResolvedValue(true),
    onStart: vi.fn(),
    ...over,
  };
}

beforeEach(() => invokeMock.mockReset());

describe("the IPC wrappers", () => {
  it("name the Rust commands and their arguments", async () => {
    invokeMock.mockResolvedValue([]);
    await listMoveDestinations("5Acc", "Main");
    expect(invokeMock).toHaveBeenCalledWith("list_move_destinations", { accountId: "5Acc", currentLabel: "Main" });
    const request: DriveMoveRequest = { ...base, items: [], confirmSharing: false, preflight: true };
    await moveBetweenDrives("5Acc", request);
    expect(invokeMock).toHaveBeenCalledWith("move_between_drives", { accountId: "5Acc", request });
    await cancelDriveMove("job-1");
    expect(invokeMock).toHaveBeenCalledWith("cancel_drive_move", { jobId: "job-1" });
  });
});

describe("runDriveMove", () => {
  it("asks first, changing nothing, and starts the move only once nothing is left to ask", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(outcome({ ready: true }))
      .mockResolvedValueOnce(outcome({ results: [result("a.txt", "moved"), result("Trip", "moved")] }));
    const h = hooks();
    const done = await runDriveMove("5Acc", base, items, h, send);

    expect(send.mock.calls[0][1]).toMatchObject({ preflight: true, confirmSharing: false });
    expect(send.mock.calls[0][1].items).toEqual([
      { path: "a.txt", isFolder: false, onClash: "ask" },
      { path: "Trip", isFolder: true, onClash: "ask" },
    ]);
    expect(h.onStart).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1][1]).toMatchObject({ preflight: false, confirmSharing: false, jobId: "job-1" });
    expect(done.results.every((r) => r.status === "moved")).toBe(true);
  });

  it("asks about a taken name with Keep both or Skip, and never sends Replace", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(outcome({ results: [result("a.txt", "clash"), result("Trip", "clash")] }))
      .mockResolvedValueOnce(outcome({ ready: true }))
      .mockResolvedValueOnce(outcome({ results: [result("a.txt", "moved")] }));
    const askClashes = vi.fn().mockResolvedValue(
      new Map([
        ["a.txt", "replace"],
        ["Trip", "skip"],
      ]),
    );
    const done = await runDriveMove("5Acc", base, items, hooks({ askClashes }), send);

    expect(askClashes.mock.calls[0][0].map((c: { item: { path: string } }) => c.item.path)).toEqual(["a.txt", "Trip"]);
    // A Replace answer cannot be atomic across drives, so it is a skip, and
    // with every item skipped nothing more is sent.
    expect(send).toHaveBeenCalledTimes(1);
    expect(done.results.every((r) => r.status === "skipped")).toBe(true);
  });

  it("keeps both under a new name, and a closed clash prompt skips", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(outcome({ results: [result("a.txt", "clash")] }))
      .mockResolvedValueOnce(outcome({ ready: true }))
      .mockResolvedValueOnce(outcome({ results: [result("a.txt", "moved"), result("Trip", "moved")] }));
    await runDriveMove("5Acc", base, items, hooks({ askClashes: vi.fn().mockResolvedValue(new Map([["a.txt", "keepBoth"]])) }), send);
    expect(send.mock.calls[2][1].items[0]).toEqual({ path: "a.txt", isFolder: false, onClash: "keepBoth" });

    const closed = vi.fn().mockResolvedValueOnce(outcome({ results: [result("a.txt", "clash"), result("Trip", "clash")] }));
    const nothing = await runDriveMove("5Acc", base, items, hooks({ askClashes: vi.fn().mockResolvedValue(null) }), closed);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(nothing.results.every((r) => r.status === "skipped")).toBe(true);
  });

  it("confirms what a shared folder loses, and a no moves nothing", async () => {
    const declined = vi.fn().mockResolvedValueOnce(outcome({ confirm: "Moving it to another drive turns off its share link." }));
    const h = hooks({ confirmSharing: vi.fn().mockResolvedValue(false) });
    const result1 = await runDriveMove("5Acc", base, items, h, declined);
    expect(h.confirmSharing).toHaveBeenCalledWith("Moving it to another drive turns off its share link.");
    expect(declined).toHaveBeenCalledTimes(1);
    expect(h.onStart).not.toHaveBeenCalled();
    expect(result1.cancelled).toBe(true);

    const accepted = vi
      .fn()
      .mockResolvedValueOnce(outcome({ confirm: "Moving it…" }))
      .mockResolvedValueOnce(outcome({ ready: true }))
      .mockResolvedValueOnce(outcome({ results: [result("Trip", "moved")], revoked: "Its share link was turned off." }));
    const done = await runDriveMove("5Acc", base, items, hooks(), accepted);
    expect(accepted.mock.calls[1][1]).toMatchObject({ preflight: true, confirmSharing: true });
    expect(accepted.mock.calls[2][1]).toMatchObject({ preflight: false, confirmSharing: true });
    expect(done.revoked).toBe("Its share link was turned off.");
  });

  it("never starts when the preflight finds nothing to move", async () => {
    const send = vi.fn().mockResolvedValueOnce(outcome({ results: [result("a.txt", "failed")] }));
    const h = hooks();
    const done = await runDriveMove("5Acc", base, items, h, send);
    expect(h.onStart).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(done.results[0].status).toBe("failed");
  });
});

describe("movedToDriveMessage", () => {
  it("names the folder and the drive, and nothing for no move", () => {
    expect(movedToDriveMessage(2, "Albums/2024", "2024", "Team")).toBe("Moved to 2024 in Team");
    expect(movedToDriveMessage(1, "", "Team", "Team")).toBe("Moved to Team");
    expect(movedToDriveMessage(0, "", "Team", "Team")).toBeNull();
  });
});
