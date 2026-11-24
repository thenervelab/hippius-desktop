import { describe, expect, it, vi } from "vitest";

import type { RestartBlocker } from "@/lib/tauri/updates";
import {
  cancelPendingRestart,
  restartIsPending,
  startRestartWhenDone,
  waitThenRestart,
} from "../autoRestart";

const upload: RestartBlocker = {
  kind: "transfer",
  line: "Files are still uploading or downloading.",
};

describe("waitThenRestart", () => {
  it("restarts at once when nothing is in the way", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      waitThenRestart({ getBlockers: async () => [], restart, sleep }),
    ).resolves.toBe("restarted");
    expect(restart).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits while Rust reports work, then restarts once it is done", async () => {
    const answers = [[upload], [upload], []];
    const getBlockers = vi.fn(async () => answers.shift() ?? []);
    const restart = vi.fn().mockResolvedValue(undefined);
    const seen: RestartBlocker[][] = [];
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitThenRestart({
      getBlockers,
      restart,
      sleep,
      pollMs: 3000,
      onBlockers: (b) => seen.push(b),
    });

    expect(getBlockers).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(seen).toEqual([[upload], [upload]]);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("treats a question Rust cannot answer as nothing in the way", async () => {
    const restart = vi.fn().mockResolvedValue(undefined);
    await waitThenRestart({
      getBlockers: () => Promise.reject(new Error("ipc gone")),
      restart,
      sleep: vi.fn(),
    });
    expect(restart).toHaveBeenCalledOnce();
  });

  it("never restarts once cancelled", async () => {
    const controller = new AbortController();
    const restart = vi.fn();
    const sleep = vi.fn(async () => controller.abort());
    await expect(
      waitThenRestart({
        getBlockers: async () => [upload],
        restart,
        sleep,
        signal: controller.signal,
      }),
    ).resolves.toBe("cancelled");
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("startRestartWhenDone", () => {
  it("keeps one wait at a time and can be cancelled", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const restart = vi.fn();

    const first = startRestartWhenDone({
      getBlockers: async () => [upload],
      restart,
      sleep: () => gate,
    });
    expect(restartIsPending()).toBe(true);

    cancelPendingRestart();
    release();
    await expect(first).resolves.toBe("cancelled");
    expect(restartIsPending()).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });
});
