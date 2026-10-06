// Source pin for Drive's "Edit image" item. `driveEntry.test` covers which
// rows offer it; this pins that the row menu asks that rule and opens the
// editor with the path of the row the user clicked, resolved against the
// expanded subtree's folder (the same mistake `folderShareWiring` guards):
// a nested `Trips/Shot.png` resolved against the page's path would open a
// different file, or none.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const densified = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), "utf8").replace(/\s+/g, "");

describe("Drive's Edit image item", () => {
  it("is gated by offersImageEditor and opens the clicked row's path", () => {
    const source = densified("app/components/page-sections/drive/files-table/index.tsx");
    const item = source.slice(source.indexOf("offersImageEditor({"), source.indexOf('itemTitle:"Editimage"') + 400);
    expect(item).toContain("cloudOnly:isCloudOnlyRow(file)");
    expect(item).toContain("memberDrive:isMemberDriveLabel(file.label,memberDriveLabels)");
    expect(item).toContain("serverFileId:file.fileId");
    expect(item).toContain(
      "openFileInEditor(file.label,resolveRelativePath(parentSubFolderPath??normalizedSubfolderPath,file.actualFileName||file.name,),",
    );
    // A picture only on the server is opened by its id and content hash.
    expect(item).toContain("{fileId:file.fileId,arionHash:file.arionCid}");
    expect(item).toContain(".catch((error)=>toast.error(tauriErrorMessage(error)))");
  });
});
