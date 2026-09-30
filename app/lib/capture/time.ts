/** "03:07": a recording's elapsed time, as the pill and the menu bar show it. */
export function mmss(secs: number): string {
  const whole = Math.max(0, Math.floor(secs));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
