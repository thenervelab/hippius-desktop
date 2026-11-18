import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * A drop from the OS used to be heard only by the drive table, which handed
 * it to whichever Upload button was mounted: on the drive list, Shared
 * Drives and remote drives none was, and the drop did nothing. One host now
 * hears every drop and each view only says where its drops go.
 */
describe("one handler for files dropped from the OS", () => {
  it("is mounted once for the whole signed-in app", () => {
    expect(read("../../../../(pages)/layout.tsx")).toContain("<OsDropHost />");
  });

  it("is not duplicated by the drive table", () => {
    const content = read("../DriveContent.tsx");
    expect(content).not.toContain("tauri://drag");
    expect(content).not.toContain("takeTrayDrop");
  });

  it("is told where every drive view's drops go, whichever branch renders", () => {
    const container = read("../DriveContainer.tsx");
    const register = container.indexOf("useOsDropTarget({");
    // Before the branches pick the content, so the drive list and its
    // onboarding screens (which render no drive table) register too.
    expect(register).toBeGreaterThan(0);
    expect(register).toBeLessThan(container.indexOf("let content;"));
    expect(container).toContain("resolveDriveDropDestination(");
  });

  it("stands aside for every dialog that takes drops itself", () => {
    for (const file of [
      "../upload-files-flow/FileDropzone.tsx",
      "../FolderUploadDialog.tsx",
      "../../settings/AddLocalFolderDialog.tsx",
      "../../wallet/local-wallet/ImportWalletScreen.tsx",
    ]) {
      expect(read(file), file).toContain("useClaimOsDrops(");
    }
  });
});
