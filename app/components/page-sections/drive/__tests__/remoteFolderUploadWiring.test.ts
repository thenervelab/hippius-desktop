import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("uploading a folder into a drive that is not synced here", () => {
  const header = readCode("../DriveHeader.tsx");

  // The view already offered New Folder and Upload File, so a folder was
  // the one thing that could be created here but not brought in.
  it("the remote toolbar offers all three", () => {
    for (const control of [
      "RemoteNewFolderButton",
      "RemoteFolderUploadButton",
      "RemoteUploadButton",
    ]) {
      expect(header).toContain(control);
    }
  });

  const button = readCode("../RemoteFolderUploadButton.tsx");

  // A folder, not files: picking files here would silently upload the
  // wrong thing.
  it("picks a directory", () => {
    expect(button).toMatch(/directory:\s*true/);
    expect(button).toMatch(/multiple:\s*false/);
  });

  // The containing folder has to be threaded through, or a folder dropped
  // into a subfolder lands at the drive root instead.
  it("uploads under the folder being browsed", () => {
    expect(button).toContain("parentPath");
    expect(button).toMatch(/uploadFolderToRemoteFolder\([\s\S]*?parentPath,/);
  });

  // Rust walks the tree; the frontend hands over one path.
  it("does not walk the folder itself", () => {
    expect(button).not.toMatch(/readDir|readdir|walk/i);
  });

  // Same refusal dialog as every other storage limit, not a raw error.
  it("routes a storage refusal to the plans dialog", () => {
    expect(button).toContain("STORAGE_LIMIT_REACHED");
  });
});
