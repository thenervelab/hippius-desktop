// Steps scenes.html frame by frame and saves PNGs, for encode.sh to turn into a GIF.
// Run through the browser-automation runner:
//   OUT=/tmp/frames FPS=30 node <browser.mjs> "file://.../scenes.html?scene=enc&theme=light" --script render-frames.mjs
// TIMES=0,2.5,5 renders only those moments (for a quick look).
// Frames are drawn at SS times the clip's size (default 2) and encode.sh
// averages them back down: edges then land on the same blended pixels every
// frame, where a 1x render can round an edge to a different pixel as
// something moves near it.
import fs from "node:fs";
import path from "node:path";

const W = 1620;
const H = 911;

export default async function run(page) {
  const out = process.env.OUT;
  const fps = Number(process.env.FPS || 30);
  const ss = Number(process.env.SS || 2);
  fs.mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: W * ss, height: H * ss });
  // The drawing keeps its 1620 x 911 viewBox; only the pixels behind it grow.
  await page.evaluate(([w, h]) => {
    const svg = document.getElementById("stage");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
  }, [W * ss, H * ss]);
  const loop = await page.evaluate(() => Number(document.body.dataset.loop));
  const times = process.env.TIMES
    ? process.env.TIMES.split(",").map(Number)
    : Array.from({ length: Math.round(loop * fps) }, (_, i) => i / fps);
  let n = 0;
  for (const t of times) {
    await page.evaluate((s) => {
      document.body.dataset.t = String(s);
      document.dispatchEvent(new Event("render"));
      // Two frames for the new drawing to finish painting: a capture taken
      // sooner can catch a blur or mask half drawn, so a still part of the
      // scene comes out a shade different from frame to frame and shimmers.
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, t);
    const file = path.join(out, `f_${String(n).padStart(4, "0")}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W * ss, height: H * ss } });
    n++;
  }
  return { frames: n, loop, scale: ss };
}
