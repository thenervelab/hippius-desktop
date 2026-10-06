import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The popover is a separate, provider-free webview kept small (see
 * `AppShell`). Its row actions reuse the Drive's gating helpers, so this pins
 * that the row code, and the helpers it pulls in, import none of the main
 * window's machinery: no toaster, no Jotai store, no query client, no UI or
 * hook barrel. Those belong to `TrayFileActionHost` in the main window. A
 * bundle test would need a build, so the imports are pinned instead.
 */
const importsOf = (rel: string) =>
  [...readFileSync(join(process.cwd(), rel), "utf8").matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

/** Forbidden as the module itself or anything under it. */
const FORBIDDEN_TREES = [
  "sonner",
  "jotai",
  "@tanstack/react-query",
  "@/components/ui",
  "@/app/lib/global-atoms",
  // Not granted to the popover (`capabilities/tray-panel.json`): a call would
  // fail at run time with a permission error.
  "@tauri-apps/plugin-opener",
];
/** Forbidden exactly: the barrels and the toast-backed error helper. A
 *  single hook module under `@/app/lib/hooks/` is fine. */
const FORBIDDEN_EXACT = [
  "@/app/lib/hooks",
  "@/lib/utils/dispatchTauriError",
  "@/app/lib/utils/dispatchTauriError",
  "@/app/lib/utils",
];

const forbidden = (spec: string) =>
  FORBIDDEN_EXACT.includes(spec) ||
  FORBIDDEN_TREES.some((tree) => spec === tree || spec.startsWith(`${tree}/`));

const ROW_FILES = [
  "app/tray-panel/TrayUploadRow.tsx",
  "app/tray-panel/TrayRowMenu.tsx",
  "app/tray-panel/trayMainWindow.ts",
  "app/lib/tray/trayRowActions.ts",
  // Helpers the row calls at run time.
  "app/lib/utils/revealFile.ts",
  "app/lib/utils/renameGating.ts",
  "app/lib/utils/cloudOnly.ts",
  "app/lib/utils/filePreviewType.ts",
];

describe("the popover's row actions stay out of the main window's tree", () => {
  it.each(ROW_FILES)("%s imports no main-window machinery", (file) => {
    expect(importsOf(file).filter(forbidden)).toEqual([]);
  });

  it("would catch the toast-backed helper creeping back into revealFile", () => {
    expect(forbidden("@/lib/utils/dispatchTauriError")).toBe(true);
    expect(forbidden("sonner")).toBe(true);
    expect(forbidden("@/app/lib/hooks/use-user-files")).toBe(false);
  });
});
