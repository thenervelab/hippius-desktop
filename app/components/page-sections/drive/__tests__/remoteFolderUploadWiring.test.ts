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

  // The pick/upload sequence moved into `useRemoteUploadActions` so the
  // right-click menu runs the SAME action as this button — a browsed
  // drive's menu previously had nothing but New Folder in it. These pin
  // the behaviour where it now lives.
  const button = readCode("../RemoteFolderUploadButton.tsx");
  const action = readCode("../../../../lib/hooks/useRemoteUploadActions.ts");

  it("the button delegates rather than keeping its own copy", () => {
    expect(button).toContain("useRemoteFolderUpload");
    expect(button).not.toContain("openSelection");
  });

  // A folder, not files: picking files here would silently upload the
  // wrong thing.
  it("picks a directory", () => {
    const folderUpload = action.slice(action.indexOf("useRemoteFolderUpload"));
    expect(folderUpload).toMatch(/directory:\s*true/);
    expect(folderUpload).toMatch(/multiple:\s*false/);
  });

  // The containing folder has to be threaded through, or a folder dropped
  // into a subfolder lands at the drive root instead.
  it("uploads under the folder being browsed", () => {
    expect(action).toContain("parentPath");
    expect(action).toMatch(/uploadFolderToRemoteFolder\([\s\S]*?parentPath,/);
  });

  // Rust walks the tree; the frontend hands over one path.
  it("does not walk the folder itself", () => {
    expect(action).not.toMatch(/readDir|readdir/i);
  });

  // Same refusal dialog as every other storage limit, not a raw error.
  it("routes a storage refusal to the plans dialog", () => {
    expect(action).toContain("STORAGE_LIMIT_REACHED");
  });
});

describe("the folder upload announces a folder", () => {
  // Passing the file version a count of one announced "Your file is being
  // uploaded" for a folder of any size. The count cannot be known up front
  // — Rust only walks the tree once the upload starts.
  const surfaces = [
    ["the in-folder action", "../../../../lib/hooks/useRemoteUploadActions.ts"],
    ["the upload dialog", "../FolderUploadDialog.tsx"],
  ] as const;

  it.each(surfaces)("%s uses the folder wording", (_name, path) => {
    const src = readCode(path);
    expect(src).toContain("reportRemoteFolderUploadStarted");
    // The hook holds both actions, so scope this to the folder one —
    // the file action legitimately calls the file reporter.
    const folderScope = src.includes("useRemoteFolderUpload")
      ? src.slice(src.indexOf("useRemoteFolderUpload"))
      : src;
    expect(folderScope).not.toMatch(/reportRemoteUploadStarted\s*\(/);
  });

  it("the folder notice never says file", () => {
    const copy = readCode("../../../../lib/remote-upload/reportOutcome.ts");
    const started = copy.slice(copy.indexOf("reportRemoteFolderUploadStarted"));
    expect(started).toMatch(/Your folder is being uploaded/);
  });
});
