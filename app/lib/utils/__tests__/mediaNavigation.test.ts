import { describe, it, expect, vi } from "vitest";

// `isViewableFile` → `isLocalFile` is pure, but the module imports
// `convertFileSrc` transitively; stub it so the import resolves.
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));

import { isViewableFile, getViewableFiles } from "../mediaNavigation";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const f = (over: Partial<FormattedUserFile>): FormattedUserFile =>
  ({ name: "x", ...over }) as FormattedUserFile;

const localImg = f({ name: "local.png", source: "/Users/me/Hippius/local.png" });
const cloudImg = f({ name: "cloud.jpg", fileId: "abc", label: "Drive" }); // no source
const folder = f({ name: "dir", isFolder: true });
const textFile = f({ name: "notes.txt", source: "/Users/me/Hippius/notes.txt" });

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

  it("never treats folders or non-media files as viewable", () => {
    expect(isViewableFile(folder)).toBe(false);
    expect(isViewableFile(textFile)).toBe(false);
  });

  it("includes BOTH local and cloud media when localOnly is off (gallery default)", () => {
    const names = getViewableFiles([localImg, cloudImg, folder, textFile]).map((x) => x.name);
    expect(names).toEqual(["local.png", "cloud.jpg"]);
  });

  it("drops cloud media when localOnly is on", () => {
    const names = getViewableFiles([localImg, cloudImg], { localOnly: true }).map((x) => x.name);
    expect(names).toEqual(["local.png"]);
  });
});
