import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

/** Source with comments stripped, so prose explaining a rule cannot satisfy it. */
const readCode = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("every folder list has an empty state", () => {
  // A heading, a button in the corner and a blank panel underneath says
  // nothing about what the page is for — and on a new account this is the
  // whole of the Drive page.
  const lists = [
    ["the Drive page", "../../DriveOnboarding.tsx"],
    ["Settings", "../../../settings/MultiFolderSyncManager.tsx"],
  ] as const;

  it.each(lists)("%s passes one to FolderList", (_name, path) => {
    const src = readCode(path);
    expect(src).toMatch(/emptyState=\{/);
    expect(src).toContain("FolderListEmptyState");
  });
});

describe("FolderListEmptyState", () => {
  const src = readCode("../FolderListEmptyState.tsx");

  // Uploading needs somewhere to upload TO. With no folders at all, the
  // picker would open on nothing, so syncing is the only offer.
  it("offers syncing a folder, not uploading into one", () => {
    expect(src).toContain("SYNC_FOLDER_LABEL");
    expect(src).not.toMatch(/ADD_FILE_LABEL|ADD_FOLDER_LABEL/);
  });

  // The list card already draws the border and surface; a second one
  // would read as a panel inside a panel.
  it("draws no card of its own", () => {
    expect(src).toMatch(/cardView=\{false\}/);
  });
});
