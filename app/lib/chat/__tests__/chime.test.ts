// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  type ChimeContext,
  NOTE_SECONDS,
  NOTES,
  PEAK_GAIN,
  playChime,
} from "@/lib/chat/chime";

interface Scheduled {
  frequency: number;
  start: number;
  stop: number;
  gains: number[];
}

/** An `AudioContext` that records what would have played instead of playing it. */
function fakeContext(state: AudioContextState = "running") {
  const notes: Scheduled[] = [];
  const destination = { id: "speakers" } as unknown as AudioNode;
  let connectedToSpeakers = 0;
  const resume = vi.fn(async () => {
    ctx.state = "running";
  });
  const ctx: ChimeContext & { state: AudioContextState } = {
    currentTime: 10,
    destination,
    state,
    resume,
    createOscillator() {
      const note: Scheduled = { frequency: 0, start: -1, stop: -1, gains: [] };
      notes.push(note);
      return {
        type: "sine",
        frequency: { setValueAtTime: (hz: number) => (note.frequency = hz) },
        connect: (gain: { values: number[] }) => {
          // Envelope values were scheduled on the gain before the oscillator
          // was wired to it; adopt them by reference.
          note.gains = gain.values;
        },
        start: (t: number) => (note.start = t),
        stop: (t: number) => (note.stop = t),
      } as unknown as OscillatorNode;
    },
    createGain() {
      const values: number[] = [];
      const node = {
        values,
        gain: {
          setValueAtTime: (v: number) => values.push(v),
          exponentialRampToValueAtTime: (v: number) => values.push(v),
        },
        connect: (d: AudioNode) => {
          if (d === destination) connectedToSpeakers += 1;
        },
      };
      return node as unknown as GainNode;
    },
  };
  return { ctx, notes, resume, speakers: () => connectedToSpeakers };
}

describe("playChime", () => {
  it("schedules two consecutive notes, each through its own gain to the speakers", async () => {
    const { ctx, notes, speakers } = fakeContext();
    await playChime(() => ctx);
    expect(notes.map((n) => n.frequency)).toEqual([...NOTES]);
    expect(speakers()).toBe(2);
    // Second note starts where the first ends; nothing overlaps or gaps.
    expect(notes[1].start - notes[0].start).toBeCloseTo(NOTE_SECONDS, 6);
    expect(notes[0].start).toBeGreaterThan(ctx.currentTime);
  });

  it("keeps the whole chime around 150 ms and never louder than the peak gain", async () => {
    const { ctx, notes } = fakeContext();
    await playChime(() => ctx);
    const total = notes[1].stop - notes[0].start;
    expect(total).toBeGreaterThan(0.14);
    expect(total).toBeLessThan(0.17);
    for (const note of notes) {
      expect(Math.max(...note.gains)).toBeLessThanOrEqual(PEAK_GAIN);
      expect(PEAK_GAIN).toBeLessThanOrEqual(0.2);
      // Fades back out before the oscillator stops: no click at the end.
      expect(note.gains.at(-1)).toBeLessThan(0.001);
    }
  });

  it("resumes a suspended context before playing", async () => {
    const { ctx, notes, resume } = fakeContext("suspended");
    await playChime(() => ctx);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(notes).toHaveLength(2);
  });

  it("is a silent no-op when the context cannot run or cannot be created", async () => {
    const { ctx, notes, resume } = fakeContext("suspended");
    resume.mockImplementationOnce(async () => undefined); // stays suspended
    await playChime(() => ctx);
    expect(notes).toHaveLength(0);

    await expect(
      playChime(() => {
        throw new Error("no audio device");
      }),
    ).resolves.toBeUndefined();
  });
});
