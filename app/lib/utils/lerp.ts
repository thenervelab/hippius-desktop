import { Rgb } from "@/lib/types/rgb";

// Linearly interpolate between 2 values given a third value between 0 -> 1 as its anchor
export const lerp = (v0: number, v1: number, t: number): number => {
  // Ensure t is between 0 and 1
  const tClamped = Math.max(0, Math.min(1, t));
  return (1 - tClamped) * v0 + tClamped * v1;
};

/**
 * Inverse Linear Interpolation, get the fraction between `a` and `b` on which `v` resides.
 * Returns a value between 0 and 1 representing the relative position of `v` between `a` and `b`.
 * If `v` is not between `a` and `b`, the result can be outside the range [0, 1].
 */
export const inLerp = (a: number, b: number, v: number): number => {
  // Avoid division by zero
  if (a === b) {
    return 0;
  }
  return (v - a) / (b - a);
};

export const lerpBetweeenRGB = (
  color1: Rgb,
  color2: Rgb,
  anchor: number
): Rgb => {
  return [
    lerp(color1[0], color2[0], anchor),
    lerp(color1[1], color2[1], anchor),
    lerp(color1[2], color2[2], anchor),
  ];
};

/**
 * Remap a number `v` from one range [inMin, inMax] to another range [outMin, outMax].
 */
export const remap = (
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number => {
  const t = inLerp(inMin, inMax, v);
  return lerp(outMin, outMax, t);
};
