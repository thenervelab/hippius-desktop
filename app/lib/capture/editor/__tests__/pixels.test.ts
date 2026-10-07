import { describe, expect, it } from "vitest";
import { BLUR_CELLS_ACROSS, blur, blurCell, pixelBox, pixelate, type Pixels } from "../pixels";

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

/**
 * A line of "text" at Retina scale: black glyph-sized bars on white, `size`
 * pixels tall and as wide as a bold letter's strokes, inside a box drawn
 * tightly around it, like a user boxing an email address to hide it.
 */
function textLine(width: number, height: number, stroke: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const ink = Math.floor(x / stroke) % 2 === 0 && y > height * 0.15 && y < height * 0.85;
      const v = ink ? 0 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/**
 * How much a letter's worth of horizontal travel still changes the picture
 * along the line's middle row: the largest difference between two pixels one
 * stroke apart. This is what makes text legible (ink next to paper); a slow
 * drift across the whole box does not spell anything. Old blur left up to
 * 147 of 255 here on a 10 px stroke; a wash leaves under a tenth of that.
 */
function letterContrast(px: Pixels, stroke: number): number {
  let most = 0;
  for (const y of [Math.floor(px.height / 2), Math.floor(px.height * 0.3)]) {
    for (let x = 0; x + stroke < px.width; x++) {
      const a = pixel(px, x, y)[0];
      const b = pixel(px, x + stroke, y)[0];
      most = Math.max(most, Math.abs(a - b));
    }
  }
  return most;
}

describe("blur hides text", () => {
  // The reported bug: blurred text stayed readable. Blur used to pixelate at
  // half the picture's block whatever the box's size, so letters as wide as
  // a few blocks kept their shape through the wash.
  it.each([
    // [width, height, stroke, block]: a boxed line of text on a Retina shot,
    // small text on a small picture, a big heading, and a paragraph.
    [240, 40, 14, 25],
    [120, 18, 5, 8],
    [300, 32, 10, 8],
    [600, 60, 20, 25],
    [800, 400, 16, 25],
  ])("leaves no letter-scale contrast in a %ix%i box of %ipx strokes (block %i)", (w, h, stroke, block) => {
    const px = textLine(w, h, stroke);
    expect(letterContrast(textLine(w, h, stroke), stroke)).toBe(255);
    blur(px, { x: 0, y: 0, w, h }, block);
    expect(letterContrast(px, stroke)).toBeLessThan(24);
  });

  it("is never finer than the picture's block, and coarser for a taller region", () => {
    expect(blurCell({ x: 0, y: 0, w: 300, h: 12 }, 8)).toBe(8);
    expect(blurCell({ x: 0, y: 0, w: 300, h: 40 }, 8)).toBe(40 / BLUR_CELLS_ACROSS);
    // A dragged-up box (negative size) is measured by its extent.
    expect(blurCell({ x: 0, y: 0, w: -300, h: -40 }, 8)).toBe(20);
    // Capped, so a huge region is a wash rather than two giant tiles.
    expect(blurCell({ x: 0, y: 0, w: 4000, h: 4000 }, 10)).toBe(30);
  });
});
