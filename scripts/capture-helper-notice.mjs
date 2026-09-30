#!/usr/bin/env node
//
// After `pnpm tauri:build`: say so when the macOS app it made has no
// screen-recording helper, and how to get one.
//
// `tauri build` knows nothing about `Contents/MacOS/HippiusCapture` (it is not
// an externalBin, see .claude/rules/macos-packaging.md), so a plain local
// build runs fine and shows Record disabled. This does NOT embed the helper:
// by the time it runs Tauri has already made the DMG, so an embed here would
// fix the .app and leave the DMG people install without recording, and an ad
// hoc re-sign would replace a Developer ID signature. `pnpm build:mac-local`
// does the whole flow properly.
//
// Never fails the build and prints nothing off macOS. CI does not run it: the
// release lanes call `tauri build` through tauri-action, not this npm script,
// and embed the helper in `finalize-macos-release.sh`.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Where a host-arch `tauri build` puts the app. */
export function bundledAppPath(repoRoot, cargoTargetDir) {
  const tauriDir = join(repoRoot, "src-tauri");
  let target = join(tauriDir, "target");
  if (cargoTargetDir) target = isAbsolute(cargoTargetDir) ? cargoTargetDir : join(tauriDir, cargoTargetDir);
  return join(target, "release", "bundle", "macos", "Hippius.app");
}

/**
 * The notice, or null when there is nothing to say: not a Mac, no app was
 * bundled (a failed or non-app build), or the helper is already there.
 */
export function helperNotice({ platform, appPath, appExists, helperExists }) {
  if (platform !== "darwin" || !appExists || helperExists) return null;
  return [
    "",
    `NOTE: ${appPath} has no screen-recording helper,`,
    "      so screenshots work but Record shows as not included in this build.",
    "      For a build with recording, camera and microphone, run: pnpm build:mac-local",
    "",
  ].join("\n");
}

function main(env) {
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const appPath = bundledAppPath(repoRoot, env.CARGO_TARGET_DIR);
    const notice = helperNotice({
      platform: process.platform,
      appPath,
      appExists: existsSync(appPath),
      helperExists: existsSync(join(appPath, "Contents", "MacOS", "HippiusCapture")),
    });
    if (notice) console.warn(notice);
  } catch {
    // A notice must never fail a build that succeeded.
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.env));
}
