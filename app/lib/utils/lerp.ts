// Linearly interpolate between 2 values given a third value between 0 -> 1 as its anchor
export const lerp = (v0: number, v1: number, t: number): number => {
  // Ensure t is between 0 and 1
  const tClamped = Math.max(0, Math.min(1, t));
  return (1 - tClamped) * v0 + tClamped * v1;
};
