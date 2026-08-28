import { describe, it, expect, vi } from "vitest";

// `isViewableFile` → `isLocalFile` is pure, but the module imports
// `convertFileSrc` transitively; stub it so the import resolves.
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

import {
  getNextViewableFile,
  getPrevViewableFile,
  getViewableFileType,
  getViewableFiles,
  isViewableFile,
} from "../mediaNavigation";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const f = (over: Partial<FormattedUserFile>): FormattedUserFile =>
  ({ name: "x", ...over }) as FormattedUserFile;

const localImg = f({ name: "local.png", source: "/Users/me/Hippius/local.png" });
const cloudImg = f({ name: "cloud.jpg", fileId: "abc", label: "Drive" }); // no source
const folder = f({ name: "dir", isFolder: true });
const textFile = f({ name: "notes.txt", source: "/Users/me/Hippius/notes.txt" });
const archive = f({ name: "bundle.zip", source: "/Users/me/Hippius/bundle.zip" });
const doc = f({ name: "contract.docx", source: "/Users/me/Hippius/contract.docx" });
const sheet = f({ name: "budget.XLSX", source: "/Users/me/Hippius/budget.XLSX" });
const legacyDoc = f({ name: "old.doc", source: "/Users/me/Hippius/old.doc" });

describe("isViewableFile / getViewableFiles", () => {
  it("treats a cloud-only image (no local source) as viewable by default", () => {
    // The gallery must include server/other-device files so their thumbnails
    // can render — the regression this fix targets.
    expect(isViewableFile(cloudImg)).toBe(true);
  });

  it("still excludes cloud-only files under the legacy localOnly filter", () => {
    expect(isViewableFile(cloudImg, { localOnly: true })).toBe(false);
    expect(isViewableFile(localImg, { localOnly: true })).toBe(true);
  });

  it("never treats folders or unsupported files as viewable", () => {
    expect(isViewableFile(folder)).toBe(false);
    expect(isViewableFile(archive)).toBe(false);
    // Legacy binary Office has no renderer, so it must stay out of the
    // gallery rather than being stepped onto by prev/next.
    expect(isViewableFile(legacyDoc)).toBe(false);
  });

  it("includes the document formats the unified viewer can open", () => {
    // The gallery and the dialog ask the SAME classifier. When they disagreed,
    // a newly supported format opened on click but was skipped by the arrow
    // keys and missing from the thumbnail rail.
    expect(isViewableFile(textFile)).toBe(true);
    expect(isViewableFile(doc)).toBe(true);
    expect(isViewableFile(sheet)).toBe(true);
    expect(getViewableFileType(doc)).toBe("document");
    expect(getViewableFileType(sheet)).toBe("spreadsheet");
    expect(getViewableFileType(folder)).toBeNull();
  });

  it("includes BOTH local and cloud files when localOnly is off (gallery default)", () => {
    const names = getViewableFiles([localImg, cloudImg, folder, textFile, archive]).map(
      (x) => x.name,
    );
    expect(names).toEqual(["local.png", "cloud.jpg", "notes.txt"]);
  });

  it("walks prev/next across mixed formats in list order", () => {
    // Sibling-list scoping for the new formats: a folder holding a photo, a
    // Word file and a spreadsheet steps through all three, skipping the
    // unsupported archive rather than stopping at it.
    const siblings = [localImg, doc, archive, sheet];
    expect(getNextViewableFile(localImg, siblings)?.name).toBe("contract.docx");
    expect(getNextViewableFile(doc, siblings)?.name).toBe("budget.XLSX");
    expect(getNextViewableFile(sheet, siblings)).toBeNull();
    expect(getPrevViewableFile(sheet, siblings)?.name).toBe("contract.docx");
    expect(getPrevViewableFile(localImg, siblings)).toBeNull();
  });

  it("drops cloud media when localOnly is on", () => {
    const names = getViewableFiles([localImg, cloudImg], { localOnly: true }).map((x) => x.name);
    expect(names).toEqual(["local.png"]);
  });
});
