import { describe, expect, it } from "vitest";
import { folderUrlForPath } from "../openFolderPath";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const folder = (name: string): FormattedUserFile =>
  ({ name, actualFileName: name, isFolder: true, arionHash: `hash-${name}`, source: "" }) as unknown as FormattedUserFile;
const file = (name: string): FormattedUserFile =>
  ({ name, actualFileName: name, isFolder: false, arionHash: `hash-${name}` }) as unknown as FormattedUserFile;
// A drive root: no folder params in the URL yet.
const noParams = ((_key: string, fallback?: string) => fallback ?? "") as Parameters<typeof folderUrlForPath>[2];
const params = (url: string | null) => new URLSearchParams((url ?? "").split("?")[1]);

describe("folderUrlForPath", () => {
  const rows = [file("Captures"), folder("Captures"), folder("Photos")];

  it("opens a top-level folder the way a click on its row does", () => {
    const p = params(folderUrlForPath(rows, "Captures", noParams));
    expect(p.get("folderActualName")).toBe("Captures");
    expect(p.get("folderCid")).toBe("hash-Captures");
  });

  it("opens a nested folder, naming the whole path", () => {
    const p = params(folderUrlForPath(rows, "Captures/2026/September/", noParams));
    expect(p.get("folderName")).toBe("September");
    expect(p.get("mainFolderActualName")).toBe("Captures");
    expect(p.get("subFolderPath")).toBe("Captures/2026/September");
  });

  it("does not mistake a file for the folder of the same name", () => {
    expect(folderUrlForPath([file("Captures")], "Captures", noParams)).toBeNull();
  });

  it("answers null for an empty path or a folder that is not in the drive", () => {
    expect(folderUrlForPath(rows, "", noParams)).toBeNull();
    expect(folderUrlForPath(rows, "Missing/Deeper", noParams)).toBeNull();
  });
});
