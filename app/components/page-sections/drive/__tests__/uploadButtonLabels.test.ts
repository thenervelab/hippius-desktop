import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  UPLOAD_FILE_BUTTON_LABEL,
  UPLOAD_FILE_LABEL,
  UPLOAD_FOLDER_BUTTON_LABEL,
  UPLOAD_FOLDER_LABEL,
} from "../uploadActions";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Every surface that renders an upload BUTTON, not a menu row. */
const BUTTON_SURFACES = [
  ["the shared upload-file CTA", "../AddFileButton.tsx"],
  ["the drive header", "../DriveHeader.tsx"],
  ["the folder list toolbar", "../DriveOnboarding.tsx"],
  ["the remote file button", "../RemoteUploadButton.tsx"],
  ["the remote folder button", "../RemoteFolderUploadButton.tsx"],
] as const;

describe("upload buttons carry the verb in the icon", () => {
  it("labels the buttons with the noun alone", () => {
    expect(UPLOAD_FILE_BUTTON_LABEL).toBe("File");
    expect(UPLOAD_FOLDER_BUTTON_LABEL).toBe("Folder");
  });

  // Menus, dialog titles and tooltips have no icon to carry the verb, so
  // the full phrase has to survive for them.
  it("keeps the full phrase for surfaces with no icon", () => {
    expect(UPLOAD_FILE_LABEL).toBe("Upload File");
    expect(UPLOAD_FOLDER_LABEL).toBe("Upload Folder");
  });

  it.each(BUTTON_SURFACES)("%s draws the upload icon", (_name, path) => {
    expect(readCode(path)).toContain("ArrowUpToLine");
  });

  it.each(BUTTON_SURFACES)("%s uses the short label", (_name, path) => {
    expect(readCode(path)).toMatch(/UPLOAD_(FILE|FOLDER)_BUTTON_LABEL/);
  });

  // The plus said "new", which is what these buttons do NOT do — they
  // upload something that already exists.
  it.each(BUTTON_SURFACES)("%s no longer prefixes a plus", (_name, path) => {
    const src = readCode(path);
    expect(src).not.toMatch(/\+ \{UPLOAD/);
    expect(src).not.toMatch(/`\+ \$\{UPLOAD/);
  });
});

describe("the context menu keeps its verbs", () => {
  // A menu row has no icon carrying the action and no button beside it to
  // contrast with, so "File" alone would not say what it does.
  it("still reads Upload File and Upload Folder", () => {
    const menu = readCode("../../../ui/context-menu/AppContextMenu.tsx");
    expect(menu).toContain("UPLOAD_FILE_LABEL");
    expect(menu).toContain("UPLOAD_FOLDER_LABEL");
    expect(menu).not.toMatch(/BUTTON_LABEL/);
  });
});
