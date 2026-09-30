import { describe, expect, it } from "vitest";
import { folderUrlForPath, resolvePendingFolder, shouldOpenFromUrl } from "../openFolderPath";
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

describe("folder names as the disk spells them", () => {
  // macOS lists names decomposed (NFD); a path built from typed text is composed.
  it("finds a folder whatever Unicode form its name is in", () => {
    const decomposed = [folder("Cafe\u0301")];
    expect(folderUrlForPath(decomposed, "Caf\u00e9", noParams)).not.toBeNull();
  });

  it("does not trim a name: a trailing space is part of it", () => {
    expect(folderUrlForPath([folder("Notes ")], "Notes ", noParams)).not.toBeNull();
    expect(folderUrlForPath([folder("Notes")], "Notes ", noParams)).toBeNull();
  });
});

describe("resolvePendingFolder", () => {
  const before = [folder("Photos")];
  const after = [folder("Photos"), folder("Captures")];

  it("goes to the folder when the listing has it", () => {
    const next = resolvePendingFolder({ path: "Captures", missedOn: null }, after, noParams);
    expect(next.url).not.toBeNull();
    expect(next.pending).toBeNull();
  });

  // The first capture into a drive creates Captures; the listing that opens
  // first can predate it.
  it("waits for one refresh of the listing before giving up", () => {
    const first = resolvePendingFolder({ path: "Captures", missedOn: null }, before, noParams);
    expect(first.url).toBeNull();
    expect(first.pending).not.toBeNull();
    // The same listing again (a re-render, not a refresh) keeps waiting.
    expect(resolvePendingFolder(first.pending!, before, noParams).pending).toBe(first.pending);
    // The refreshed listing has it.
    expect(resolvePendingFolder(first.pending!, after, noParams).url).not.toBeNull();
    // Or it still does not, and the wait ends.
    expect(resolvePendingFolder(first.pending!, [folder("Photos")], noParams)).toEqual({ url: null, pending: null });
  });
});

describe("shouldOpenFromUrl", () => {
  const request = { label: "Work", remote: false, subfolder: "Captures" };

  // The Drive page stays mounted across "Show in folder" clicks; a guard set
  // once per mount left every click after the first dead.
  it("opens every new request on the same page", () => {
    const first = shouldOpenFromUrl(null, request);
    expect(first.open).toBe(true);
    // The page clears the params once it has opened the folder.
    const cleared = shouldOpenFromUrl(first.key, { label: null, remote: false, subfolder: null });
    expect(cleared).toEqual({ open: false, key: null });
    // The same folder asked for again is opened again.
    expect(shouldOpenFromUrl(cleared.key, request).open).toBe(true);
    expect(shouldOpenFromUrl(first.key, { ...request, label: "Photos" }).open).toBe(true);
  });

  // Two captures in the same folder, one after the other: the second one's
  // file must be pointed out too.
  it("treats another file in the same folder as a new request", () => {
    const first = shouldOpenFromUrl(null, { ...request, file: "a.png" });
    expect(shouldOpenFromUrl(first.key, { ...request, file: "b.png" }).open).toBe(true);
    expect(shouldOpenFromUrl(first.key, { ...request, file: "a.png" }).open).toBe(false);
  });

  it("does not open the same request twice while its params are still there", () => {
    const first = shouldOpenFromUrl(null, request);
    expect(shouldOpenFromUrl(first.key, request)).toEqual({ open: false, key: first.key });
  });
});
