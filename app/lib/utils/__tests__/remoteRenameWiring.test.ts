import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("renaming a file in a browsed remote drive", () => {
  // A remote FILE row carries no `source` — that absence is what marks it
  // cloud-only for download and preview routing — so the drive it belongs
  // to has to be carried explicitly, or the row cannot be renamed.
  it("the listing tags every remote row with its drive", () => {
    const listing = readCode("../../hooks/use-nested-folder-listing.ts");
    expect(listing).toMatch(/remoteDriveLabel:\s*remote\s*\?/);
  });

  // The menu gate and the rename must resolve the drive the same way, or
  // a row offers Rename and then fails on the way to the server.
  it("the gate and the rename share one resolver", () => {
    expect(readCode("../renameGating.ts")).toContain("remoteDriveLabel");
    expect(readCode("../../hooks/use-rename-file/index.tsx")).toContain(
      "remoteDriveLabel(file)",
    );
  });

  // Without this the renamed row keeps its old name until the user
  // navigates away, which reads as the rename having failed.
  it("a remote listing refreshes on an in-app mutation", () => {
    const container = readCode(
      "../../../components/page-sections/drive/DriveContainer.tsx",
    );
    // The sync-cycle event stays local-only; the mutation event does not.
    expect(container).toMatch(
      /if \(!isRemoteView\) \{\s*window\.addEventListener\("sync_files_completed_changed"/,
    );
    expect(container).not.toMatch(/if \(!isNested \|\| isRemoteView\) return;/);
  });
});
