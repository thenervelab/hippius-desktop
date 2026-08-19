import { describe, expect, it } from "vitest";
import {
  buildLiveProgressIndex,
  findLiveFileMatch,
  liveProgressIndexEqual,
  lookupLiveProgress,
} from "../useFileLiveProgress";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

function fp(
  path: string,
  overrides: Partial<FileProgress> = {},
): FileProgress {
  return {
    path,
    fileName: path.split("/").pop() ?? path,
    label: "Docs",
    action: "upload",
    status: "inProgress",
    progressPercent: 0,
    bytesEncrypted: 0,
    bytesTransferred: 0,
    totalBytes: 100,
    ...overrides,
  };
}

describe("findLiveFileMatch", () => {
  it("matches on the unique relative path", () => {
    const files = [fp("/Work/a.pdf", { progressPercent: 30 }), fp("/b.pdf")];
    expect(findLiveFileMatch(files, "/Work/a.pdf")?.progressPercent).toBe(30);
  });

  it("matches across a leading-slash difference between key and path", () => {
    const files = [fp("/Work/a.pdf", { progressPercent: 42 })];
    // Server-derived key carries no leading slash; the snapshot path does.
    expect(findLiveFileMatch(files, "Work/a.pdf")?.progressPercent).toBe(42);
  });

  it("does NOT bind to the wrong file when two share a basename (the bleed bug)", () => {
    // Two in-flight files named report.pdf in different folders. A basename key
    // is ambiguous, so no live progress is returned rather than the wrong one.
    const files = [
      fp("/2023/report.pdf", { progressPercent: 10 }),
      fp("/2024/report.pdf", { progressPercent: 90 }),
    ];
    expect(findLiveFileMatch(files, "report.pdf")).toBeNull();
  });

  it("uses the basename fallback only when it is unambiguous", () => {
    const files = [fp("/2024/report.pdf", { progressPercent: 55 })];
    expect(findLiveFileMatch(files, "report.pdf")?.progressPercent).toBe(55);
  });

  it("scopes by label so the same path in another drive can't collide", () => {
    const files = [
      fp("/a.pdf", { label: "Docs", progressPercent: 10 }),
      fp("/a.pdf", { label: "Photos", progressPercent: 80 }),
    ];
    expect(findLiveFileMatch(files, "/a.pdf", "Photos")?.progressPercent).toBe(
      80,
    );
  });

  it("returns null when nothing matches", () => {
    expect(findLiveFileMatch([fp("/a.pdf")], "/missing.pdf")).toBeNull();
  });
});

describe("buildLiveProgressIndex / lookupLiveProgress", () => {
  it("agrees with findLiveFileMatch on a unique relative path", () => {
    const files = [fp("/Work/a.pdf", { progressPercent: 30 }), fp("/b.pdf")];
    const index = buildLiveProgressIndex(files);
    expect(lookupLiveProgress(index, "/Work/a.pdf", "a.pdf").progressPercent).toBe(
      30,
    );
    expect(lookupLiveProgress(index, "/Work/a.pdf", "a.pdf").status).toBe(
      "uploading",
    );
  });

  it("matches across a leading-slash difference", () => {
    const files = [fp("/Work/a.pdf", { progressPercent: 42 })];
    const index = buildLiveProgressIndex(files);
    expect(
      lookupLiveProgress(index, "Work/a.pdf", "a.pdf").progressPercent,
    ).toBe(42);
  });

  it("does not bind an ambiguous basename", () => {
    const files = [
      fp("/2023/report.pdf", { progressPercent: 10 }),
      fp("/2024/report.pdf", { progressPercent: 90 }),
    ];
    const index = buildLiveProgressIndex(files);
    expect(lookupLiveProgress(index, undefined, "report.pdf").status).toBeNull();
  });

  it("uses the basename fallback only when it is unambiguous", () => {
    const files = [fp("/2024/report.pdf", { progressPercent: 55 })];
    const index = buildLiveProgressIndex(files);
    expect(
      lookupLiveProgress(index, undefined, "report.pdf").progressPercent,
    ).toBe(55);
  });

  it("scopes by label so the same path in another drive cannot collide", () => {
    const files = [
      fp("/a.pdf", { label: "Docs", progressPercent: 10 }),
      fp("/a.pdf", { label: "Photos", progressPercent: 80 }),
    ];
    const index = buildLiveProgressIndex(files);
    expect(
      lookupLiveProgress(index, "/a.pdf", "a.pdf", "Photos").progressPercent,
    ).toBe(80);
    expect(lookupLiveProgress(index, "/a.pdf", "a.pdf").status).toBeNull();
  });

  it("buckets percent so 10.4 and 10.9 share a cell", () => {
    const a = buildLiveProgressIndex([
      fp("/a.pdf", { progressPercent: 10.4 }),
    ]);
    const b = buildLiveProgressIndex([
      fp("/a.pdf", { progressPercent: 10.9 }),
    ]);
    expect(liveProgressIndexEqual(a, b)).toBe(true);
    expect(lookupLiveProgress(a, "/a.pdf", "a.pdf").progressPercent).toBe(10);
  });

  it("returns empty when nothing matches", () => {
    const index = buildLiveProgressIndex([fp("/a.pdf")]);
    expect(lookupLiveProgress(index, "/missing.pdf", "missing.pdf").status).toBeNull();
  });
});
