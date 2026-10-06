import { describe, expect, it } from "vitest";
import { blur, pixelBox, pixelate, type Pixels } from "../pixels";

/** A picture of distinct pixels, like text: every pixel differs from its neighbours. */
function noisy(width: number, height: number, seed = 7): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = s & 255;
    data[i + 1] = (s >> 8) & 255;
    data[i + 2] = (s >> 16) & 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

const pixel = (px: Pixels, x: number, y: number) => Array.from(px.data.slice((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));

function distinctColours(px: Pixels, x0: number, y0: number, x1: number, y1: number): number {
  const seen = new Set<string>();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) seen.add(pixel(px, x, y).join(","));
  return seen.size;
}

describe("pixelate", () => {
  it("writes each block's average into every pixel of the block, so its detail is gone", () => {
    const px = noisy(32, 32);
    const before = distinctColours(px, 0, 0, 16, 16);
    pixelate(px, { x: 0, y: 0, w: 16, h: 16 }, 8);
    expect(before).toBeGreaterThan(200);
    // 16 x 16 at 8 px blocks: four colours left, one per block.
    expect(distinctColours(px, 0, 0, 16, 16)).toBeLessThanOrEqual(4);
    expect(pixel(px, 0, 0)).toEqual(pixel(px, 7, 7));
  });

  it("is irreversible: two different pictures with the same block averages export the same pixels", () => {
    const a: Pixels = { data: new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 255]), width: 2, height: 1 };
    const b: Pixels = { data: new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]), width: 2, height: 1 };
    pixelate(a, { x: 0, y: 0, w: 2, h: 1 }, 2);
    pixelate(b, { x: 0, y: 0, w: 2, h: 1 }, 2);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("changes nothing outside the region", () => {
    const px = noisy(20, 20);
    const outside = pixel(px, 15, 15);
    pixelate(px, { x: 0, y: 0, w: 10, h: 10 }, 4);
    expect(pixel(px, 15, 15)).toEqual(outside);
    expect(pixel(px, 10, 0)).toEqual(pixel(noisy(20, 20), 10, 0));
  });

  it("ignores a region outside the picture", () => {
    const px = noisy(4, 4);
    const copy = Array.from(px.data);
    pixelate(px, { x: 10, y: 10, w: 5, h: 5 }, 2);
    expect(Array.from(px.data)).toEqual(copy);
    expect(pixelBox({ x: -5, y: -5, w: 2, h: 2 }, 4, 4)).toBeNull();
  });
});

describe("blur", () => {
  it("changes every pixel in the region and none outside", () => {
    const px = noisy(40, 40);
    const original = noisy(40, 40);
    blur(px, { x: 10, y: 10, w: 20, h: 20 }, 8);
    let changed = 0;
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) if (pixel(px, x, y).join() !== pixel(original, x, y).join()) changed++;
    expect(changed).toBeGreaterThan(20 * 20 * 0.95);
    expect(pixel(px, 5, 5)).toEqual(pixel(original, 5, 5));
    expect(pixel(px, 30, 30)).toEqual(pixel(original, 30, 30));
  });

  it("leaves a smooth wash: neighbouring pixels end up close, where the original jumped", () => {
    const px = noisy(40, 40);
    blur(px, { x: 0, y: 0, w: 40, h: 40 }, 12);
    const a = pixel(px, 20, 20);
    const b = pixel(px, 21, 20);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(20);
  });
});
