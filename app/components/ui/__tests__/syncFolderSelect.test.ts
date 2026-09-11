import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const select = readFileSync(join(here, "../SyncFolderSelect.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * Every caller of this picker is a dialog. An absolutely-positioned menu
 * inside one still counts toward that dialog's scroll area, so opening the
 * menu grew the dialog and gave it a scrollbar instead of drawing over it.
 */
describe("the drive menu draws over its dialog", () => {
  it("renders in a portal, out of the dialog's flow", () => {
    expect(select).toContain("createPortal");
  });

  /**
   * ...but into the DIALOG, not `document.body`. Radix's Dialog runs
   * `react-remove-scroll`, which `preventDefault()`s every wheel event
   * landing outside the dialog content — so a body-portalled menu showed
   * a scrollbar and refused to scroll, with no attribute to opt out of
   * the lock. Falls back to `document.body` outside a dialog.
   */
  it("portals inside the dialog so the wheel reaches the list", () => {
    expect(select).toMatch(/closest<HTMLElement>\('\[role="dialog"\]'\)/);
    expect(select).toContain("container ?? document.body");
  });

  it("is positioned from the trigger, in viewport coordinates", () => {
    expect(select).toContain("getBoundingClientRect");
    expect(select).toMatch(/position:\s*"fixed"/);
  });

  // A fixed menu does not follow its trigger, so it closes rather than
  // drifting away from it.
  it("closes when anything moves the trigger", () => {
    expect(select).toMatch(/addEventListener\("resize"/);
    expect(select).toMatch(/addEventListener\("scroll"/);
  });

  /**
   * The scroll listener is capturing, so it also sees the option list
   * scrolling ITSELF — which closed the menu the instant the user reached
   * for an option below the fold. A long drive list became unusable.
   */
  it("ignores scrolling that came from inside the menu", () => {
    const handler = select.slice(
      select.indexOf("const onScroll"),
      select.indexOf("const onScroll") + 200,
    );
    expect(handler).toContain("menuRef.current?.contains");
  });

  it("scrolls the list rather than growing without limit", () => {
    expect(select).toMatch(/max-h-\[?\d+/);
    expect(select).toContain("overflow-y-auto");
  });

  /**
   * The menu is outside the component's own subtree, so an outside-click
   * handler that checks only the container closes on `mousedown` before
   * the option's `click` lands — and the selection silently never happens.
   */
  it("treats the portalled menu as inside", () => {
    expect(select).toContain("menuRef.current?.contains");
    expect(select).toContain("containerRef.current?.contains");
  });
});

/**
 * One row style, everywhere. It began as an opt-in variant for the New
 * Folder dialog, but all three callers — that dialog, Upload File and
 * Upload Folder — want the same thing, so the second style was a branch
 * nothing took.
 */
describe("every drive option reads the same way", () => {
  it("shows which kind of drive each one is", () => {
    expect(select).toContain("Remote folder");
    expect(select).toContain("On this computer");
    // Names what a remote drive IS, not what it lacks.
    expect(select).not.toContain("Not synced here");
  });

  it("marks the drive in use", () => {
    expect(select).toContain("isSelected");
    expect(select).toMatch(/<Check\b/);
  });

  it("keeps no second row style to drift from this one", () => {
    expect(select).not.toContain("optionVariant");
    expect(select).not.toContain("comfortable");
  });
});

/**
 * The drive is chosen the same way wherever it is chosen. Three dialogs
 * ask the question — New Folder, Upload File and Upload Folder — and all
 * three ask it with this component.
 */
describe("every dialog picks a drive with this component", () => {
  const callers = [
    ["New Folder", "../../page-sections/drive/NewFolderDialog.tsx"],
    ["Upload File", "../../page-sections/drive/upload-files-flow/index.tsx"],
    ["Upload Folder", "../../page-sections/drive/FolderUploadDialog.tsx"],
  ] as const;

  it.each(callers)("%s uses the shared picker", (_name, path) => {
    const src = readFileSync(join(here, path), "utf8");
    expect(src).toContain("SyncFolderSelect");
  });
});
