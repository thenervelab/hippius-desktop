import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dialog = readFileSync(join(here, "../NewFolderDialog.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * One dialog for both kinds of drive, because the two Rust commands are
 * the only difference: a synced drive gets a real directory, a browsed one
 * a registered folder entity.
 */
describe("the New Folder dialog", () => {
  it("creates in a synced drive and in a browsed one", () => {
    expect(dialog).toContain("create_sync_folder");
    expect(dialog).toContain("create_remote_folder");
  });

  // The app's own picker, not a native control: it already lists local and
  // remote drives, reports which kind each is, and looks like the rest of
  // the app. A hand-rolled `<select>` duplicated all three badly.
  it("picks the drive with the shared picker", () => {
    expect(dialog).toContain("SyncFolderSelect");
    expect(dialog).not.toMatch(/<select\b/);
    expect(dialog).not.toMatch(/<option\b/);
  });

  // Remote drives are real destinations here, so they must be offered.
  it("offers browsed drives too", () => {
    expect(dialog).toContain("includeRemote");
  });

  // Asking only where there is no answer already: a view with a folder
  // open passes its own target.
  it("only asks when no folder is open", () => {
    expect(dialog).toContain("needsDrive");
    expect(dialog).toMatch(/!target\?\.label/);
  });

  // The picker hides itself on a single-drive account, so the destination
  // would otherwise go unnamed.
  it("names where the folder will land", () => {
    expect(dialog).toContain("Created in");
  });

  // Rust validates the name; a second copy of the rules here would drift.
  it("leaves name validation to the backend", () => {
    expect(dialog).toContain("errorMessage(err)");
    expect(dialog).not.toMatch(/\.\.|includes\("\/"\)/);
  });
});
