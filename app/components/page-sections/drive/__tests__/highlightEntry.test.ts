import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  HIGHLIGHT_MS,
  entryKey,
  findEntryIndex,
  isEntryNamed,
  isRequestedLevel,
  nextHighlightStep,
  pageForIndex,
  stepForLocatedPage,
  type HighlightRequest,
} from "../highlightEntry";

const file = (name: string, actual = name): FormattedUserFile =>
  ({ name, actualFileName: actual, isFolder: false }) as unknown as FormattedUserFile;
const folder = (name: string): FormattedUserFile =>
  ({ name, actualFileName: name, isFolder: true }) as unknown as FormattedUserFile;
const level = (n: number) => Array.from({ length: n }, (_, i) => file(`Screen ${String(i).padStart(2, "0")}.png`));

const request = (name: string, until = 10_000): HighlightRequest => ({
  label: "Work",
  folder: "Captures",
  name,
  until,
});
const view = (ordered: FormattedUserFile[], over: Partial<Parameters<typeof nextHighlightStep>[1]> = {}) => ({
  ordered,
  serverPaged: false,
  paged: true,
  page: 1,
  pageSize: 20,
  now: 0,
  ...over,
});

describe("isEntryNamed", () => {
  it("matches exactly, in one Unicode form, and never a folder", () => {
    expect(isEntryNamed(file("Café.png"), "Café.png")).toBe(true);
    expect(isEntryNamed(file("a.png"), "A.png")).toBe(false);
    expect(isEntryNamed(file("Notes "), "Notes")).toBe(false);
    expect(isEntryNamed(folder("Captures"), "Captures")).toBe(false);
    // A listing may name the row by either field.
    expect(isEntryNamed(file("shown.png", "real.png"), "real.png")).toBe(true);
  });

  it("keys a row the way the lookup asks for it", () => {
    expect(entryKey(file("x", "Café.png"))).toBe("Café.png");
  });
});

describe("pageForIndex", () => {
  it("is 1-based and tolerates a zero page size", () => {
    expect(pageForIndex(0, 20)).toBe(1);
    expect(pageForIndex(19, 20)).toBe(1);
    expect(pageForIndex(20, 20)).toBe(2);
    expect(pageForIndex(39, 20)).toBe(2);
    expect(pageForIndex(5, 0)).toBe(6);
  });
});

describe("nextHighlightStep", () => {
  // A folder of forty captures, shown twenty at a time.
  it("goes to the page of the current order that holds the file", () => {
    const rows = level(40);
    expect(findEntryIndex(rows, "Screen 25.png")).toBe(25);
    expect(nextHighlightStep(request("Screen 25.png"), view(rows))).toEqual({ kind: "page", page: 2 });
    expect(nextHighlightStep(request("Screen 25.png"), view(rows, { page: 2 }))).toEqual({
      kind: "show",
      file: rows[25],
    });
    // A new sort is a new order: the same file lands on the other page.
    const reversed = [...rows].reverse();
    expect(nextHighlightStep(request("Screen 25.png"), view(reversed, { page: 2 }))).toEqual({ kind: "page", page: 1 });
  });

  it("shows at once on a level that is not paged (a filter's result)", () => {
    const rows = level(40);
    expect(nextHighlightStep(request("Screen 39.png"), view(rows, { paged: false }))).toEqual({
      kind: "show",
      file: rows[39],
    });
  });

  it("shows a file on the server page in hand, and asks Rust for any other page", () => {
    const page = level(20);
    expect(nextHighlightStep(request("Screen 03.png"), view(page, { serverPaged: true, page: 3 }))).toEqual({
      kind: "show",
      file: page[3],
    });
    expect(nextHighlightStep(request("Screen 99.png"), view(page, { serverPaged: true }))).toEqual({ kind: "locate" });
  });

  it("waits for a file not listed yet, then gives up quietly", () => {
    const rows = level(3);
    expect(nextHighlightStep(request("new.png", 8000), view(rows, { now: 7999 }))).toEqual({ kind: "wait" });
    expect(nextHighlightStep(request("new.png", 8000), view(rows, { now: 8000 }))).toEqual({ kind: "give-up" });
  });
});

describe("stepForLocatedPage", () => {
  it("goes to the page Rust found, or waits when it is the page on screen", () => {
    expect(stepForLocatedPage(3, 1)).toEqual({ kind: "page", page: 3 });
    // The page on screen predates the file: a refresh will bring it.
    expect(stepForLocatedPage(1, 1)).toEqual({ kind: "wait" });
    expect(stepForLocatedPage(null, 1)).toEqual({ kind: "wait" });
  });
});

describe("isRequestedLevel", () => {
  it("is the requested drive and folder, compared in NFC with slashes ignored", () => {
    const r = { ...request("a.png"), folder: "Captures/Café" };
    expect(isRequestedLevel(r, { label: "Work", folder: "/Captures/Café/" })).toBe(true);
    expect(isRequestedLevel(r, { label: "Work", folder: "Captures" })).toBe(false);
    expect(isRequestedLevel(r, { label: "Home", folder: "Captures/Café" })).toBe(false);
    // The drive's root, before the folder step has run.
    expect(isRequestedLevel({ ...r, folder: "" }, { label: "Work", folder: "" })).toBe(true);
    expect(isRequestedLevel(r, { label: null, folder: null })).toBe(false);
  });
});

// The fade in globals.css and the timer that removes the attribute must
// agree, or the highlight is cut off mid-fade (or lingers after it).
describe("the highlight's style", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../globals.css"), "utf8");

  it("lasts as long as the highlight is kept", () => {
    expect(css).toContain(`animation: drive-highlight ${HIGHLIGHT_MS}ms`);
  });

  it("has its own colours in dark mode, keyed off .dark", () => {
    expect(css).toMatch(/\.dark \[data-drive-highlight\]\s*\{[^}]*--drive-highlight-rgb/);
  });
});
