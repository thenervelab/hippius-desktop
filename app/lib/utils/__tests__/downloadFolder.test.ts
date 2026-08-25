import { describe, expect, it } from "vitest";
import {
  defaultFolderZipFileName,
  FOLDER_ZIP_DIALOG_FILTERS,
} from "@/app/lib/utils/downloadFolder";

describe("folder zip save dialog", () => {
  it("filters the OS save dialog to .zip", () => {
    expect(FOLDER_ZIP_DIALOG_FILTERS).toEqual([
      { name: "Zip Archive", extensions: ["zip"] },
    ]);
  });

  it("defaults the save name to {folderName}.zip", () => {
    expect(defaultFolderZipFileName("Photos")).toBe("Photos.zip");
    expect(defaultFolderZipFileName("Folder")).toBe("Folder.zip");
  });
});
