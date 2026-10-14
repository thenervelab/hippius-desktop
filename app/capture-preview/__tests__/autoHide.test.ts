import { describe, expect, it } from "vitest";
import {
  barOffsetMs,
  nextCountdown,
  pauseCountdown,
  resumeCountdown,
  startCountdown,
  timeLeft,
} from "@/app/capture-preview/autoHide";

const TOTAL = 10_000;

describe("the card's countdown", () => {
  it("runs the whole time when nothing holds it, and stops at zero", () => {
    const c = startCountdown(1, TOTAL, 500, false);
    expect(timeLeft(c, 500)).toBe(TOTAL);
    expect(timeLeft(c, 4_500)).toBe(6_000);
    expect(timeLeft(c, 10_500)).toBe(0);
    expect(timeLeft(c, 60_000)).toBe(0);
  });

  it("starts held when the pointer is already on the card", () => {
    const c = startCountdown(1, TOTAL, 0, true);
    expect(c.runningSince).toBeNull();
    expect(timeLeft(c, 30_000)).toBe(TOTAL);
  });

  // The bug: leaving the card started the whole wait over.
  it("keeps the time that was left across a pause, and runs on from it", () => {
    const paused = pauseCountdown(startCountdown(1, TOTAL, 0, false), 3_000);
    expect(timeLeft(paused, 3_000)).toBe(7_000);
    expect(timeLeft(paused, 50_000)).toBe(7_000);
    const resumed = resumeCountdown(paused, 50_000);
    expect(timeLeft(resumed, 50_000)).toBe(7_000);
    expect(timeLeft(resumed, 54_000)).toBe(3_000);
    expect(timeLeft(resumed, 57_000)).toBe(0);
  });

  it("adds up several pauses to the whole time, never more", () => {
    let c = startCountdown(1, TOTAL, 0, false);
    c = pauseCountdown(c, 2_000); // ran 2 s
    c = resumeCountdown(c, 5_000);
    c = pauseCountdown(c, 6_000); // ran 1 s
    c = resumeCountdown(c, 20_000);
    c = pauseCountdown(c, 23_000); // ran 3 s
    expect(timeLeft(c, 29_000)).toBe(4_000);
    c = resumeCountdown(c, 30_000);
    expect(timeLeft(c, 33_999)).toBe(1);
    expect(timeLeft(c, 34_000)).toBe(0);
  });

  it("keeps the last moments of a pause near the end, and a spent countdown stays spent", () => {
    let c = pauseCountdown(startCountdown(1, TOTAL, 0, false), 9_950);
    expect(timeLeft(c, 20_000)).toBe(50);
    c = resumeCountdown(c, 20_000);
    expect(timeLeft(c, 20_049)).toBe(1);
    expect(timeLeft(c, 20_050)).toBe(0);

    // Held only after the time ran out (the dismissal not run yet): nothing
    // is given back, and letting go ends it at once.
    const late = pauseCountdown(startCountdown(1, TOTAL, 0, false), 12_000);
    expect(late.leftMs).toBe(0);
    expect(timeLeft(resumeCountdown(late, 40_000), 40_000)).toBe(0);
  });

  it("changes nothing when paused twice or resumed while running", () => {
    const running = startCountdown(1, TOTAL, 0, false);
    expect(resumeCountdown(running, 4_000)).toBe(running);
    const paused = pauseCountdown(running, 4_000);
    expect(pauseCountdown(paused, 9_000)).toBe(paused);
    expect(timeLeft(paused, 9_000)).toBe(6_000);
  });

  it("never gives time back to a clock read out of order", () => {
    const c = startCountdown(1, TOTAL, 5_000, false);
    expect(timeLeft(c, 4_000)).toBe(TOTAL);
  });

  it("draws the timer bar from the time already run at the last pause", () => {
    const c = startCountdown(1, TOTAL, 0, false);
    expect(barOffsetMs(c)).toBe(0);
    const paused = pauseCountdown(c, 3_000);
    expect(barOffsetMs(paused)).toBe(3_000);
    // Running on keeps the offset: the bar carries on from where it stopped.
    expect(barOffsetMs(resumeCountdown(paused, 8_000))).toBe(3_000);
  });
});

describe("following the card on screen", () => {
  it("has no countdown while no card is settled", () => {
    expect(nextCountdown(null, null, false, TOTAL, 0)).toBeNull();
    const c = startCountdown(1, TOTAL, 0, false);
    expect(nextCountdown(c, null, false, TOTAL, 1_000)).toBeNull();
  });

  it("starts a card that has just settled, held or not", () => {
    expect(nextCountdown(null, 1, false, TOTAL, 2_000)).toEqual(startCountdown(1, TOTAL, 2_000, false));
    expect(nextCountdown(null, 1, true, TOTAL, 2_000)).toEqual(startCountdown(1, TOTAL, 2_000, true));
  });

  it("pauses and resumes the same card, keeping its time", () => {
    let c = nextCountdown(null, 1, false, TOTAL, 0);
    c = nextCountdown(c, 1, true, TOTAL, 6_000);
    expect(c && timeLeft(c, 60_000)).toBe(4_000);
    c = nextCountdown(c, 1, false, TOTAL, 60_000);
    expect(c && timeLeft(c, 63_000)).toBe(1_000);
  });

  it("returns the same countdown when the hold did not change", () => {
    const running = nextCountdown(null, 1, false, TOTAL, 0);
    expect(nextCountdown(running, 1, false, TOTAL, 3_000)).toBe(running);
    const held = nextCountdown(running, 1, true, TOTAL, 3_000);
    expect(nextCountdown(held, 1, true, TOTAL, 5_000)).toBe(held);
  });

  it("gives another card the whole time, not what the last one had left", () => {
    const old = pauseCountdown(startCountdown(1, TOTAL, 0, false), 8_000);
    const next = nextCountdown(old, 2, false, TOTAL, 9_000);
    expect(next?.cardId).toBe(2);
    expect(next && timeLeft(next, 9_000)).toBe(TOTAL);
  });
});
