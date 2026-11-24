// Steps scenes.html frame by frame and saves PNGs, for encode.sh to turn into a GIF.
// Run through the browser-automation runner:
//   OUT=/tmp/frames FPS=30 node <browser.mjs> "file://.../scenes.html?scene=enc&theme=light" --script render-frames.mjs
// TIMES=0,2.5,5 renders only those moments (for a quick look).
import fs from "node:fs";
import path from "node:path";

export default async function run(page) {
  const out = process.env.OUT;
  const fps = Number(process.env.FPS || 30);
  fs.mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1620, height: 911 });
  const loop = await page.evaluate(() => Number(document.body.dataset.loop));
  const times = process.env.TIMES
    ? process.env.TIMES.split(",").map(Number)
    : Array.from({ length: Math.round(loop * fps) }, (_, i) => i / fps);
  let n = 0;
  for (const t of times) {
    await page.evaluate((s) => {
      document.body.dataset.t = String(s);
      document.dispatchEvent(new Event("render"));
    }, t);
    const file = path.join(out, `f_${String(n).padStart(4, "0")}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1620, height: 911 } });
    n++;
  }
  return { frames: n, loop };
}
