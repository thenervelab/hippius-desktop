import { describe, expect, it, vi } from "vitest";
import type { Doc } from "../model";
import { applyRedactions, arrowHead, contrastOn, exportPng, exportRegion, redactRegions } from "../render";

/**
 * A stand-in for a 2D canvas that keeps real pixels for get/putImageData and
 * records drawing calls, so the export's ORDER is tested: the redactions are
 * in the pixels that get encoded, and the drawings go on after them.
 */
function fakeCanvas(w: number, h: number) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const n = i / 4;
    pixels[i] = (n * 37) & 255;
    pixels[i + 1] = (n * 91) & 255;
    pixels[i + 2] = (n * 13) & 255;
    pixels[i + 3] = 255;
  }
  const calls: string[] = [];
  let encoded: Uint8ClampedArray | null = null;
  const ctx = {
    drawImage: vi.fn((_img: unknown, dx: number, dy: number) => calls.push(`drawImage ${dx},${dy}`)),
    getImageData: vi.fn(() => {
      calls.push("getImageData");
      return { data: pixels.slice(), width: w, height: h };
    }),
    putImageData: vi.fn((img: { data: Uint8ClampedArray }) => {
      calls.push("putImageData");
      pixels.set(img.data);
    }),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn((x: number, y: number) => calls.push(`translate ${x},${y}`)),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(() => calls.push("stroke")),
    fill: vi.fn(),
    strokeRect: vi.fn(() => calls.push("strokeRect")),
    ellipse: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
  };
  const canvas = {
    width: w,
    height: h,
    getContext: () => ctx,
    toBlob: (cb: (b: Blob | null) => void) => {
      calls.push("toBlob");
      encoded = pixels.slice();
      // jsdom's Blob has no arrayBuffer(); the encoder's bytes are all that matter.
      cb({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer } as unknown as Blob);
    },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx, calls, pixels: () => pixels, encoded: () => encoded };
}

describe("exportPng", () => {
  it("writes blur and pixelate into the encoded pixels before the drawings, inside the crop", async () => {
    const doc: Doc = {
      crop: { x: 10, y: 5, w: 40, h: 30 },
      annotations: [
        { id: "p", kind: "pixelate", rect: { x: 10, y: 5, w: 20, h: 20 } },
        { id: "r", kind: "rect", rect: { x: 12, y: 12, w: 10, h: 10 }, color: "#FF3B30", width: 2 },
      ],
    };
    let made: ReturnType<typeof fakeCanvas> | null = null;
    const before = fakeCanvas(40, 30).pixels().slice();
    const png = await exportPng({} as CanvasImageSource, 200, 100, doc, 8, (w, h) => {
      made = fakeCanvas(w, h);
      return made.canvas;
    });
    expect(Array.from(png)).toEqual([137, 80, 78, 71]);
    const m = made!;
    expect(m.canvas.width).toBe(40);
    expect(m.canvas.height).toBe(30);
    // The crop's corner is the canvas's origin.
    expect(m.calls[0]).toBe("drawImage -10,-5");
    const order = (c: string) => m.calls.indexOf(c);
    expect(order("getImageData")).toBeLessThan(order("putImageData"));
    expect(order("putImageData")).toBeLessThan(order("strokeRect"));
    expect(order("strokeRect")).toBeLessThan(order("toBlob"));
    // The pixelated block (crop-relative 0..8) is one colour in what was encoded.
    const encoded = m.encoded()!;
    const at = (x: number, y: number) => Array.from(encoded.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
    expect(at(0, 0)).toEqual(at(7, 7));
    expect(at(0, 0)).not.toEqual(Array.from(before.slice(0, 4)));
    // Outside the redaction, the picture is as it was.
    expect(at(35, 25)).toEqual(Array.from(before.slice((25 * 40 + 35) * 4, (25 * 40 + 35) * 4 + 4)));
  });

  it("reads no pixels back when nothing is redacted, and exports the whole picture uncropped", async () => {
    let made: ReturnType<typeof fakeCanvas> | null = null;
    await exportPng({} as CanvasImageSource, 64, 48, { crop: null, annotations: [] }, 8, (w, h) => {
      made = fakeCanvas(w, h);
      return made.canvas;
    });
    expect(made!.ctx.getImageData).not.toHaveBeenCalled();
    expect(made!.canvas.width).toBe(64);
    expect(exportRegion({ crop: null, annotations: [] }, 64, 48)).toEqual({ x: 0, y: 0, w: 64, h: 48 });
  });

  it("fails plainly when the window cannot draw", async () => {
    const broken = { getContext: () => null } as unknown as HTMLCanvasElement;
    await expect(exportPng({} as CanvasImageSource, 10, 10, { crop: null, annotations: [] }, 8, () => broken)).rejects.toThrow(/can't draw/);
  });
});

describe("drawing helpers", () => {
  it("puts the arrow's head at its tip, pointing along the shaft", () => {
    const [tip, left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4);
    expect(tip).toEqual({ x: 100, y: 0 });
    expect(left.x).toBeLessThan(100);
    expect(right.x).toBeLessThan(100);
    expect(left.y).toBeCloseTo(-right.y);
  });

  it("picks black on light colours and white on dark ones", () => {
    expect(contrastOn("#FFCC00")).toBe("#000000");
    expect(contrastOn("#FFFFFF")).toBe("#000000");
    expect(contrastOn("#007AFF")).toBe("#FFFFFF");
    expect(contrastOn("not a colour")).toBe("#FFFFFF");
  });

  it("offsets redactions by the crop's corner", () => {
    const px = { data: new Uint8ClampedArray(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? 255 : i)), width: 4, height: 4 };
    const untouched = Array.from(px.data.slice(0, 4));
    applyRedactions(px, { crop: null, annotations: [{ id: "p", kind: "pixelate", rect: { x: 12, y: 12, w: 2, h: 2 } }] }, { x: 10, y: 10 }, 2);
    expect(Array.from(px.data.slice(0, 4))).toEqual(untouched);
    const at = (x: number, y: number) => Array.from(px.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
    expect(at(2, 2)).toEqual(at(3, 3));
  });
});

describe("redactRegions", () => {
  /** A picture of distinct pixels behind a get/put surface, as a canvas holds it. */
  function surface(w: number, h: number) {
    const data = new Uint8ClampedArray(w * h * 4);
    let seed = 11;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = seed & 255;
      data[i + 1] = (seed >> 8) & 255;
      data[i + 2] = (seed >> 16) & 255;
      data[i + 3] = 255;
    }
    const reads: number[] = [];
    const ctx = {
      getImageData: (x: number, y: number, bw: number, bh: number) => {
        reads.push(bw * bh);
        const out = new Uint8ClampedArray(bw * bh * 4);
        for (let row = 0; row < bh; row++) out.set(data.subarray(((y + row) * w + x) * 4, ((y + row) * w + x + bw) * 4), row * bw * 4);
        return { data: out, width: bw, height: bh } as unknown as ImageData;
      },
      putImageData: (img: ImageData, x: number, y: number) => {
        for (let row = 0; row < img.height; row++) data.set(img.data.subarray(row * img.width * 4, (row + 1) * img.width * 4), ((y + row) * w + x) * 4);
      },
    };
    return { ctx, data, reads };
  }

  const doc: Doc = {
    crop: null,
    annotations: [
      { id: "b", kind: "blur", color: "#000000", width: 1, rect: { x: 10.5, y: 4.25, w: 37, h: 21 } },
      { id: "p", kind: "pixelate", color: "#000000", width: 1, rect: { x: 30, y: 15, w: 40, h: 30 } },
      { id: "edge", kind: "blur", color: "#000000", width: 1, rect: { x: 70, y: 50, w: 40, h: 40 } },
      { id: "a", kind: "arrow", color: "#ff0000", width: 4, from: { x: 0, y: 0 }, to: { x: 5, y: 5 } },
    ],
  } as Doc;

  it("writes the same pixels as redacting the whole picture", () => {
    const w = 80;
    const h = 60;
    const whole = surface(w, h);
    const px = whole.ctx.getImageData(0, 0, w, h);
    applyRedactions(px, doc, { x: 0, y: 0 }, 6);
    const boxed = surface(w, h);
    redactRegions(boxed.ctx, doc.annotations, w, h, 6);
    expect(Array.from(boxed.data)).toEqual(Array.from(px.data));
  });

  it("reads only each redaction's own box, never the whole picture", () => {
    const boxed = surface(80, 60);
    redactRegions(boxed.ctx, doc.annotations, 80, 60, 6);
    expect(boxed.reads).toHaveLength(3);
    for (const n of boxed.reads) expect(n).toBeLessThan(80 * 60);
  });
});
