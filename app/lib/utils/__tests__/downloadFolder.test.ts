import { describe, expect, it } from "vitest";
import {
  defaultFolderZipFileName,
  exportFolderZipToPath,
  FOLDER_ZIP_DIALOG_FILTERS,
  pickFolderZipSavePath,
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

  it("splits the save dialog from the pack IPC", () => {
    expect(typeof pickFolderZipSavePath).toBe("function");
    expect(typeof exportFolderZipToPath).toBe("function");
  });
});
