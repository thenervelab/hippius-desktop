// scripts/capture-helper-notice.mjs runs after every `pnpm tauri:build`, on
// every platform. It must speak only about a macOS app that really lacks the
// helper, and must look where Tauri really put the app.

import { describe, it, expect } from "vitest";

import { bundledAppPath, helperNotice } from "../capture-helper-notice.mjs";

describe("bundledAppPath", () => {
  it("defaults to the repo's own target dir", () => {
    expect(bundledAppPath("/repo", undefined)).toBe("/repo/src-tauri/target/release/bundle/macos/Hippius.app");
  });

  it("honours a shared CARGO_TARGET_DIR, relative ones from src-tauri as cargo reads them", () => {
    expect(bundledAppPath("/repo", "/shared/target")).toBe("/shared/target/release/bundle/macos/Hippius.app");
    expect(bundledAppPath("/repo", "out")).toBe("/repo/src-tauri/out/release/bundle/macos/Hippius.app");
  });
});

describe("helperNotice", () => {
  const app = "/t/release/bundle/macos/Hippius.app";

  it("points a Mac build without the helper at build:mac-local", () => {
    const notice = helperNotice({ platform: "darwin", appPath: app, appExists: true, helperExists: false });
    expect(notice).toContain(app);
    expect(notice).toContain("pnpm build:mac-local");
  });

  it("says nothing when the helper is in, when no app was bundled, or off macOS", () => {
    expect(helperNotice({ platform: "darwin", appPath: app, appExists: true, helperExists: true })).toBeNull();
    expect(helperNotice({ platform: "darwin", appPath: app, appExists: false, helperExists: false })).toBeNull();
    expect(helperNotice({ platform: "win32", appPath: app, appExists: true, helperExists: false })).toBeNull();
    expect(helperNotice({ platform: "linux", appPath: app, appExists: true, helperExists: false })).toBeNull();
  });
});
