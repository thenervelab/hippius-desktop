/**
 * The microphone meter on the capture bar: how many of its bars a level
 * lights. The level itself (0 to 1, on a decibel scale) is Rust's
 * (`capture::mic_meter::level_from_rms`).
 */

/** How many of `bars` a level lights; any sound at all lights one. */
export function litBars(level: number, bars: number): number {
  if (!(level > 0)) return 0;
  return Math.min(bars, Math.max(1, Math.round(level * bars)));
}
