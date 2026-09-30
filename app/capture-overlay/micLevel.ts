/**
 * The microphone meter on the capture bar, decided without the Web Audio API
 * so it can be tested: how loud a slice of samples is, and how many of the
 * meter's bars that lights.
 */

/** Quieter than this (dBFS) reads as silence; louder than the top, as full. */
const FLOOR_DB = -60;
const TOP_DB = -10;

/**
 * How loud `samples` (the analyser's time-domain floats, -1 to 1) are, from
 * 0 (silence) to 1 (loud speech), on a decibel scale so a quiet voice still
 * moves the meter.
 */
export function levelFrom(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (TOP_DB - FLOOR_DB)));
}

/** How many of `bars` a level lights; any sound at all lights one. */
export function litBars(level: number, bars: number): number {
  if (!(level > 0)) return 0;
  return Math.min(bars, Math.max(1, Math.round(level * bars)));
}
