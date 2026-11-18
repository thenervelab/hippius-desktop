import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoveItemResult } from "../moveLogic";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { moveEntries, runMove, type MoveRequestItem } from "../runMove";

const drive = { label: "docs", remote: false };
const items = [
  { path: "a.txt", isFolder: false, name: "a.txt" },
  { path: "Trip", isFolder: true, name: "Trip" },
];

const res = (path: string, status: MoveItemResult["status"], over: Partial<MoveItemResult> = {}): MoveItemResult => ({
  path,
  isFolder: path === "Trip",
  status,
  newPath: status === "moved" ? `Reports/${path}` : null,
  message: null,
  clashIsFolder: false,
  replaced: false,
  ...over,
});

beforeEach(() => invokeMock.mockReset());

describe("moveEntries", () => {
  it("sends the request in the shape the Rust command takes, asking on a clash by default", async () => {
    invokeMock.mockResolvedValue({ results: [] });
    await moveEntries("5Acc", { label: "shared:x~y", remote: true }, "Reports", [
      { path: "a.txt", isFolder: false },
      { path: "b.txt", isFolder: false, name: "b.txt", onClash: "keepBoth" },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("move_entries", {
      accountId: "5Acc",
      request: {
        label: "shared:x~y",
        remote: true,
        destination: "Reports",
        items: [
          { path: "a.txt", isFolder: false, name: null, onClash: "ask" },
          { path: "b.txt", isFolder: false, name: "b.txt", onClash: "keepBoth" },
        ],
      },
    });
  });
});

describe("runMove", () => {
  it("moves in one request when nothing clashes and never asks", async () => {
    const send = vi.fn().mockResolvedValue([res("a.txt", "moved"), res("Trip", "moved")]);
    const ask = vi.fn();
    const results = await runMove("5Acc", drive, "Reports", items, ask, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
    expect(results.map((r) => r.status)).toEqual(["moved", "moved"]);
  });

  it("asks about clashes, then moves only those, as answered", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce([res("a.txt", "clash"), res("Trip", "clash", { clashIsFolder: true })])
      .mockResolvedValueOnce([res("a.txt", "moved", { newPath: "Reports/a (1).txt" })]);
    const ask = vi.fn().mockResolvedValue(new Map([["a.txt", "keepBoth"], ["Trip", "skip"]]));

    const results = await runMove("5Acc", drive, "Reports", items, ask, send);

    expect(ask).toHaveBeenCalledWith([
      { item: items[0], takenByFolder: false },
      { item: items[1], takenByFolder: true },
    ]);
    const retried = send.mock.calls[1][3] as MoveRequestItem[];
    expect(retried).toEqual([{ path: "a.txt", isFolder: false, onClash: "keepBoth" }]);
    expect(results.map((r) => r.status)).toEqual(["moved", "skipped"]);
    expect(results[0].newPath).toBe("Reports/a (1).txt");
  });

  it("treats a closed prompt as skipping every clash and moves nothing more", async () => {
    const send = vi.fn().mockResolvedValueOnce([res("a.txt", "clash"), res("Trip", "moved")]);
    const results = await runMove("5Acc", drive, "Reports", items, vi.fn().mockResolvedValue(null), send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.status)).toEqual(["skipped", "moved"]);
  });
});
