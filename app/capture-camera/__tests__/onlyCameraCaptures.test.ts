import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "__tests__") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/**
 * WebKit lets one page per process capture at a time: a second Hippius window
 * calling `getUserMedia` mutes the camera bubble (black, also in the
 * recording) and the bubble reopening mutes that window. The bubble is the
 * one page that may open a device; the bar's microphone meter is measured by
 * Rust (`capture::mic_meter`).
 */
describe("webview capture", () => {
  it("happens only in the camera window", () => {
    const callers = sources(join(ROOT, "app"))
      .filter((path) => readFileSync(path, "utf8").includes("getUserMedia("))
      .map((path) => relative(ROOT, path));
    expect(callers).toEqual(["app/capture-camera/page.tsx"]);
  });
});
