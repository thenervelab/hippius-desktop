/**
 * The SheetJS half of the two-parser design.
 *
 * ExcelJS is stubbed to reject every workbook, which is exactly the condition
 * the fallback exists for (it returns an empty model or throws on
 * namespace-prefixed OOXML from some generators). SheetJS's *reader* is
 * stubbed too, so the projection can be driven with the shapes SheetJS
 * actually reports — `!cols`/`!rows` sizing, `w` formatted values, pattern
 * fills, hidden-sheet flags — none of which survive a community-build
 * write/read round trip and so cannot be produced from real bytes here.
 * Everything else in the module (SSF formatting, cell addressing) stays real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkBook } from "xlsx";

import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  EXCEL_DEFAULT_COLUMN_WIDTH,
  cellKindFromType,
  excelColumnWidthToPixels,
  parseSpreadsheetPreview,
  pointsToPixels,
  readableTextColor,
} from "@/app/lib/utils/preview/spreadsheetPreview";

const stub = vi.hoisted(() => ({
  workbook: null as WorkBook | null,
  readError: null as Error | null,
}));

vi.mock("exceljs", () => ({
  ValueType: { Formula: 6 },
  Workbook: class {
    xlsx = {
      load: async () => {
        throw new Error("ExcelJS cannot read this workbook");
      },
    };
  },
}));

vi.mock("xlsx", async () => {
  const actual = await vi.importActual<typeof import("xlsx")>("xlsx");
  return {
    ...actual,
    read: () => {
      if (stub.readError) throw stub.readError;
      return stub.workbook;
    },
  };
});

const live = new AbortController().signal;
/** Zip magic, so the parser takes the workbook route and hits ExcelJS first. */
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
const CSV_BYTES = new TextEncoder().encode("a,b\n1,2\n");

type Sheet = Record<string, unknown>;

function workbookOf(sheets: Record<string, Sheet>, extra: Partial<WorkBook> = {}): WorkBook {
  return {
    SheetNames: Object.keys(sheets),
    Sheets: sheets as WorkBook["Sheets"],
    ...extra,
  } as WorkBook;
}

beforeEach(() => {
  stub.readError = null;
  stub.workbook = workbookOf({
    Data: { "!ref": "A1:A1", A1: { t: "s", v: "hello", w: "hello" } },
  });
});

describe("the SheetJS fallback", () => {
  it("takes over when ExcelJS rejects a workbook rather than failing the preview", async () => {
    // This is the whole reason for two parsers: ExcelJS throwing must not be
    // what the user sees.
    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("Data");
    expect(sheets[0].rows[0][0]).toMatchObject({ text: "hello", kind: "text" });
  });

  it("does not fall back when the request was cancelled mid-parse", async () => {
    // A cancelled parse is not a parser failure; re-parsing a file the user
    // already navigated away from is wasted work on the main thread.
    const controller = new AbortController();
    controller.abort();

    await expect(parseSpreadsheetPreview(XLSX_BYTES, controller.signal, "book.xlsx")).rejects.toThrow(
      /cancelled/i,
    );
  });
});

describe("the SheetJS fallback: sizing", () => {
  it("reads a column width from whichever unit the file used, and hides what is hidden", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:E1",
        "!cols": [{ wpx: 150.4 }, { width: 20 }, { wch: 10 }, { hidden: true }],
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].columnWidths[0]).toBe(150); // wpx wins, rounded
    expect(sheets[0].columnWidths[1]).toBe(excelColumnWidthToPixels(20));
    expect(sheets[0].columnWidths[2]).toBe(excelColumnWidthToPixels(10));
    expect(sheets[0].columnWidths[3]).toBe(0);
    // No entry at all: an .xlsx falls back to Excel's default width.
    expect(sheets[0].columnWidths[4]).toBe(EXCEL_DEFAULT_COLUMN_WIDTH);
  });

  it("gives a CSV the wider default, since it carries no widths of its own", async () => {
    stub.workbook = workbookOf({ Sheet1: { "!ref": "A1:B1" } });

    const { sheets } = await parseSpreadsheetPreview(CSV_BYTES, live, "export.csv");

    expect(sheets[0].columnWidths).toEqual([DEFAULT_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTH]);
    // A CSV's one sheet is named after the file, not "Sheet1".
    expect(sheets[0].name).toBe("export");
  });

  it("reads a row height in pixels or points, and hides what is hidden", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:A4",
        "!rows": [{ hpx: 44.6 }, { hpt: 30 }, { hidden: true }],
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rowHeights[0]).toBe(45); // hpx wins, rounded
    expect(sheets[0].rowHeights[1]).toBe(pointsToPixels(30));
    expect(sheets[0].rowHeights[2]).toBe(0);
    expect(sheets[0].rowHeights[3]).toBe(DEFAULT_ROW_HEIGHT);
  });
});

describe("the SheetJS fallback: cell values", () => {
  it("prefers the file's own formatted value over the raw one", async () => {
    // `w` is the number format already applied by the writer; recomputing it
    // would show 0.1 where the file says 10%.
    stub.workbook = workbookOf({
      Data: { "!ref": "A1:A1", A1: { t: "n", v: 0.1, w: "10%" } },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows[0][0]).toMatchObject({ text: "10%", kind: "number" });
  });

  it("formats a raw number through its own number format when `w` is absent", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:C1",
        A1: { t: "n", v: 1234.5, z: "#,##0.00" },
        B1: { t: "n", v: 45000, z: "yyyy-mm-dd" }, // a date wearing a number's type
        C1: { t: "d", v: new Date(Date.UTC(2026, 0, 15)) },
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");
    const row = sheets[0].rows[0];

    expect(row[0]).toMatchObject({ text: "1,234.50", kind: "number" });
    expect(row[1].kind).toBe("date");
    expect(row[2].kind).toBe("date");
    expect(row[2].text).toContain("2026");
  });

  it("treats a blank, a null value and SheetJS's own blank type as empty", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:D1",
        A1: { t: "z" },
        B1: { t: "s", v: "" },
        C1: { t: "s", v: null },
        // D1 absent entirely
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows[0].every((cell) => cell.kind === "empty" && cell.text === "")).toBe(true);
  });

  it("renders an error cell and a boolean as their sheet text", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:C1",
        A1: { t: "e", v: 0x07, w: "#DIV/0!" },
        B1: { t: "b", v: true, w: "TRUE" },
        C1: { t: "str", v: "=A1", w: "formula result" },
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");
    const row = sheets[0].rows[0];

    expect(row[0]).toMatchObject({ kind: "error", text: "#DIV/0!" });
    expect(row[1]).toMatchObject({ kind: "bool", text: "TRUE" });
    expect(row[2]).toMatchObject({ kind: "text", text: "formula result" });
  });

  it("reads dense sheets as well as addressed ones", async () => {
    // SheetJS is asked for `dense: true`, but older writers still produce the
    // addressed form; both have to render.
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:B1",
        "!data": [[{ t: "s", v: "dense", w: "dense" }, { t: "n", v: 7, w: "7" }]],
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows[0].map((cell) => cell.text)).toEqual(["dense", "7"]);
  });
});

describe("the SheetJS fallback: fills", () => {
  it("derives readable text for a dark fill, since this path reports no font colour", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:A1",
        A1: { t: "s", v: "on navy", w: "on navy", s: { patternType: "solid", fgColor: { rgb: "1F3864" } } },
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows[0][0].style?.fill).toBe("#1F3864");
    expect(sheets[0].rows[0][0].style?.color).toBe(readableTextColor("#1F3864"));
  });

  it("ignores a white fill and an explicitly empty pattern", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:B1",
        A1: { t: "s", v: "paper", w: "paper", s: { patternType: "solid", fgColor: { rgb: "FFFFFF" } } },
        B1: { t: "s", v: "none", w: "none", s: { patternType: "none", fgColor: { rgb: "1F3864" } } },
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows[0][0].style).toBeUndefined();
    expect(sheets[0].rows[0][1].style).toBeUndefined();
  });

  it("resolves a theme-indexed fill through the workbook's own palette", async () => {
    const clrScheme = [
      { rgb: "FFFFFF" }, { rgb: "000000" }, { rgb: "E7E6E6" }, { rgb: "44546A" },
      { rgb: "4472C4" }, { rgb: "ED7D31" }, { rgb: "A5A5A5" }, { rgb: "FFC000" },
      { rgb: "5B9BD5" }, { rgb: "70AD47" }, { rgb: "0563C1" }, { rgb: "954F72" },
    ];
    stub.workbook = workbookOf(
      {
        Data: {
          "!ref": "A1:A1",
          A1: { t: "s", v: "themed", w: "themed", s: { patternType: "solid", fgColor: { theme: 4 } } },
        },
      },
      { Themes: { themeElements: { clrScheme } } } as unknown as Partial<WorkBook>,
    );

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows[0][0].style?.fill).toBe("#4472C4");
  });
});

describe("the SheetJS fallback: sheet selection and failure", () => {
  it("hides the sheets the workbook marks hidden", async () => {
    stub.workbook = workbookOf(
      {
        Visible: { "!ref": "A1:A1", A1: { t: "s", v: "a", w: "a" } },
        Secret: { "!ref": "A1:A1", A1: { t: "s", v: "b", w: "b" } },
      },
      { Workbook: { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] } } as Partial<WorkBook>,
    );

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets.map((sheet) => sheet.name)).toEqual(["Visible"]);
  });

  it("shows every sheet rather than nothing when they are all hidden", async () => {
    stub.workbook = workbookOf(
      { Only: { "!ref": "A1:A1", A1: { t: "s", v: "a", w: "a" } } },
      { Workbook: { Sheets: [{ Hidden: 1 }] } } as Partial<WorkBook>,
    );

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets.map((sheet) => sheet.name)).toEqual(["Only"]);
  });

  it("applies merges reported by the fallback parser", async () => {
    stub.workbook = workbookOf({
      Data: {
        "!ref": "A1:C1",
        A1: { t: "s", v: "wide", w: "wide" },
        "!merges": [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }],
      },
    });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows[0][0].colSpan).toBe(3);
    expect(sheets[0].rows[0][1].covered).toBe(true);
  });

  it("renders a sheet with no used range as empty instead of throwing", async () => {
    stub.workbook = workbookOf({ Data: {} });

    const { sheets } = await parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx");

    expect(sheets[0].rows).toEqual([]);
    expect(sheets[0].columnCount).toBe(0);
  });

  it("reports a workbook with no sheets rather than rendering a blank grid", async () => {
    stub.workbook = workbookOf({});

    await expect(parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx")).rejects.toThrow(
      "This spreadsheet has no sheets.",
    );
  });

  it("names the format in the error when even the fallback cannot read the bytes", async () => {
    stub.readError = new Error("corrupt");

    await expect(parseSpreadsheetPreview(XLSX_BYTES, live, "book.xlsx")).rejects.toThrow(
      "This spreadsheet could not be opened.",
    );
    await expect(parseSpreadsheetPreview(CSV_BYTES, live, "book.csv")).rejects.toThrow(
      "This CSV file could not be read.",
    );
  });
});

describe("cellKindFromType", () => {
  it("maps every SheetJS type letter, and a date format outranks the number type", () => {
    const isDate = (format: string) => format.includes("yy");

    expect(cellKindFromType("n")).toBe("number");
    expect(cellKindFromType("n", "yyyy-mm-dd", isDate)).toBe("date");
    expect(cellKindFromType("n", "#,##0", isDate)).toBe("number");
    expect(cellKindFromType("d")).toBe("date");
    expect(cellKindFromType("b")).toBe("bool");
    expect(cellKindFromType("e")).toBe("error");
    expect(cellKindFromType("s")).toBe("text");
    expect(cellKindFromType("str")).toBe("text");
    expect(cellKindFromType("z")).toBe("empty");
    expect(cellKindFromType(undefined)).toBe("empty");
  });
});
