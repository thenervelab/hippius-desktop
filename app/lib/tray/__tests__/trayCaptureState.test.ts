import { describe, expect, it, vi } from "vitest";
import type { CapturePhase } from "@/app/lib/tauri/capture";
import {
  createTrayTitleQueue,
  followCapturePhase,
  recordingTrayTitle,
  trayClickStopsRecording,
} from "../trayCaptureState";

describe("the menu bar during a recording", () => {
  it("shows the time while recording or paused, and nothing otherwise", () => {
    expect(recordingTrayTitle({ phase: "recording", elapsedSecs: 42, microphone: true })).toBe("◼ 00:42");
    expect(recordingTrayTitle({ phase: "paused", elapsedSecs: 125, microphone: false })).toBe("❚❚ 02:05");
    expect(recordingTrayTitle({ phase: "idle" })).toBeNull();
    expect(recordingTrayTitle({ phase: "finalizing" })).toBeNull();
  });

  it("turns the icon into Stop only while a recording is live", () => {
    expect(trayClickStopsRecording({ phase: "recording", elapsedSecs: 1, microphone: false })).toBe(true);
    expect(trayClickStopsRecording({ phase: "paused", elapsedSecs: 1, microphone: false })).toBe(true);
    expect(trayClickStopsRecording({ phase: "selecting", kind: "recording", mode: "area" })).toBe(false);
    expect(trayClickStopsRecording({ phase: "delivering", kind: "recording" })).toBe(false);
  });
});

describe("the tray title's serial queue", () => {
  const deferred = () => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  // The reason the queue exists: pause then stop in quick succession, with
  // the first write still in flight. The last title written must be none.
  it("lets the newest title win when writes are slow", async () => {
    const written: (string | null)[] = [];
    const first = deferred();
    let calls = 0;
    const write = async (title: string | null) => {
      calls += 1;
      if (calls === 1) await first.promise;
      written.push(title);
    };
    const apply = createTrayTitleQueue(write, () => undefined);
    const a = apply("◼ 00:09");
    await Promise.resolve();
    apply("❚❚ 00:10");
    const last = apply(null);
    first.resolve();
    await a;
    await last;
    expect(written).toEqual(["◼ 00:09", null]);
  });

  it("writes one at a time, never two at once", async () => {
    let inFlight = 0;
    let most = 0;
    const apply = createTrayTitleQueue(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    }, () => undefined);
    apply("◼ 00:01");
    await Promise.resolve();
    apply("◼ 00:02");
    await apply("◼ 00:03");
    expect(most).toBe(1);
  });

  it("does not write the title already shown, and survives a failed write", async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error("no tray")).mockResolvedValue(undefined);
    const onError = vi.fn();
    const apply = createTrayTitleQueue(write, onError);
    await apply("◼ 00:01");
    await apply("◼ 00:01");
    await apply(null);
    expect(write).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("following the capture phase", () => {
  // A reload mid-recording: the first read of the phase answers after an
  // event did. The older read must not be applied over the newer event.
  it("drops the first read when an event arrived while it was in flight", async () => {
    const applied: string[] = [];
    let emit: (p: CapturePhase) => void = () => undefined;
    let answer: (p: CapturePhase) => void = () => undefined;
    const done = followCapturePhase(
      async (onPhase) => {
        emit = onPhase;
      },
      () => new Promise<CapturePhase>((r) => (answer = r)),
      (p) => applied.push(p.phase),
    );
    await Promise.resolve();
    emit({ phase: "idle" });
    answer({ phase: "recording", elapsedSecs: 3, microphone: false });
    await done;
    expect(applied).toEqual(["idle"]);
  });

  it("starts from the read when nothing has happened yet, and listens before reading", async () => {
    const order: string[] = [];
    const applied: string[] = [];
    await followCapturePhase(
      async () => {
        order.push("listen");
      },
      async () => {
        order.push("read");
        return { phase: "paused", elapsedSecs: 5, microphone: false };
      },
      (p) => applied.push(p.phase),
    );
    expect(order).toEqual(["listen", "read"]);
    expect(applied).toEqual(["paused"]);
  });
});
