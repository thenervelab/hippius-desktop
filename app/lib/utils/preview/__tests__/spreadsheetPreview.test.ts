import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  DEFAULT_THEME_COLORS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  applyTint,
  borderStyleWidth,
  clampExtent,
  columnLabel,
  excelColumnWidthToPixels,
  isZipArchive,
  normalizeHexColor,
  orderThemePalette,
  parseSpreadsheetPreview,
  pointsToPixels,
  readableTextColor,
  resolveColor,
  viewportFillCount,
} from "@/app/lib/utils/preview/spreadsheetPreview";

const live = new AbortController().signal;
const encode = (text: string) => new TextEncoder().encode(text);

/** Round-trips a real workbook through SheetJS so the parser sees real bytes. */
function xlsxBytes(sheets: Record<string, unknown[][]>): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

describe("columnLabel", () => {
  it("produces spreadsheet column headers past Z", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(4)).toBe("E");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
    expect(columnLabel(701)).toBe("ZZ");
  });
});

describe("clampExtent: the bound on how much a sheet can render", () => {
  it("leaves an ordinary sheet whole", () => {
    expect(clampExtent(40, 8)).toEqual({
      rowCount: 40,
      columnCount: 8,
      truncated: false,
    });
  });

  it("cuts a sheet that exceeds either cap and says so", () => {
    expect(clampExtent(MAX_TABLE_ROWS + 1, 5)).toEqual({
      rowCount: MAX_TABLE_ROWS,
      columnCount: 5,
      truncated: true,
    });
    expect(clampExtent(5, MAX_TABLE_COLUMNS + 1)).toEqual({
      rowCount: 5,
      columnCount: MAX_TABLE_COLUMNS,
      truncated: true,
    });
  });

  it("never returns a negative extent for an empty sheet", () => {
    // An empty worksheet has no `!ref`; a negative count would make
    // `Array.from({ length })` throw.
    expect(clampExtent(-1, -1)).toEqual({
      rowCount: 0,
      columnCount: 0,
      truncated: false,
    });
  });
});

describe("viewportFillCount", () => {
  it("adds enough empty units to reach the edge, plus one for the boundary line", () => {
    // Google Sheets never ends its grid where the data ends; without these the
    // preview reads as an HTML table floating on a page.
    expect(viewportFillCount(1000, 200, 100)).toBe(9);
    expect(viewportFillCount(500, 500, 100)).toBe(1);
  });

  it("adds nothing when the data already overflows the viewport", () => {
    expect(viewportFillCount(300, 900, 100)).toBe(0);
  });

  it("returns 0 for an unmeasured viewport instead of a negative count", () => {
    // The grid measures with a ResizeObserver, which reports 0 before layout
    // (and always, in a DOM without layout).
    expect(viewportFillCount(-46, 200, 100)).toBe(0);
    expect(viewportFillCount(Number.NaN, 0, 100)).toBe(0);
    expect(viewportFillCount(1000, 0, 0)).toBe(0);
  });
});

describe("unit conversions", () => {
  it("converts Excel's character-based column width to pixels", () => {
    expect(excelColumnWidthToPixels(8.43)).toBe(64);
    expect(excelColumnWidthToPixels(0)).toBe(0);
    expect(excelColumnWidthToPixels(Number.NaN)).toBe(0);
  });

  it("converts points to CSS pixels", () => {
    expect(pointsToPixels(12)).toBe(16);
    expect(pointsToPixels(14.25)).toBe(19);
  });

  it("maps OOXML border styles to pixel widths", () => {
    expect(borderStyleWidth(undefined)).toBe(0);
    expect(borderStyleWidth("none")).toBe(0);
    expect(borderStyleWidth("thin")).toBe(1);
    expect(borderStyleWidth("medium")).toBe(2);
    expect(borderStyleWidth("thick")).toBe(3);
  });
});

describe("colour model", () => {
  it("normalises ARGB and RRGGBB, and rejects anything else", () => {
    // The result goes straight into a style attribute, so a non-colour must
    // never be passed through.
    expect(normalizeHexColor("FF1F4E78")).toBe("#1F4E78");
    expect(normalizeHexColor("#1f4e78")).toBe("#1F4E78");
    expect(normalizeHexColor("red; content:x")).toBeNull();
    expect(normalizeHexColor(undefined)).toBeNull();
  });

  it("resolves a theme reference through the workbook palette", () => {
    const palette = ["#FFFFFF", "#000000", "#EEECE1", "#1F497D"];
    expect(resolveColor({ theme: 3 }, palette)).toBe("#1F497D");
    // An explicit rgb wins over the theme index.
    expect(resolveColor({ rgb: "FF0000", theme: 3 }, palette)).toBe("#FF0000");
  });

  it("resolves the legacy indexed palette", () => {
    expect(resolveColor({ indexed: 2 }, DEFAULT_THEME_COLORS)).toBe("#FF0000");
  });

  it("applies Excel's tint to a theme colour", () => {
    // A positive tint lightens, a negative one darkens; 0 is identity.
    expect(applyTint("#808080", 0)).toBe("#808080");
    expect(applyTint("#000000", 0.5)).toBe("#808080");
    expect(applyTint("#FFFFFF", -0.5)).toBe("#808080");
  });

  it("reorders a theme part into Excel's own theme index order", () => {
    // The part lists dk1,lt1,dk2,lt2 but `theme="0"` means lt1, so the first
    // two pairs swap. Getting this wrong inverts every themed fill.
    const part = ["#111111", "#EEEEEE", "#222222", "#DDDDDD", ...Array(8).fill("#333333")];
    const ordered = orderThemePalette(part);
    expect(ordered[0]).toBe("#EEEEEE");
    expect(ordered[1]).toBe("#111111");
    expect(ordered[2]).toBe("#DDDDDD");
    expect(ordered[3]).toBe("#222222");
  });

  it("falls back to the default palette for a short theme part", () => {
    expect(orderThemePalette([null, null, null, null])).toEqual(
      DEFAULT_THEME_COLORS.slice(0, 4),
    );
  });
});

describe("readableTextColor", () => {
  it("flips text to white on a dark fill", () => {
    // Only the SheetJS fallback needs this: it reports a cell's fill but not
    // its font colour, so a dark Excel header band would otherwise render
    // near-black text on a near-black background.
    expect(readableTextColor("#1F4E78")).toBe("#FFFFFF");
    expect(readableTextColor("#000000")).toBe("#FFFFFF");
  });

  it("leaves the grid's own colour alone on a light fill", () => {
    expect(readableTextColor("#FFFF00")).toBeUndefined();
    expect(readableTextColor("#D9E1F2")).toBeUndefined();
  });

  it("ignores anything that is not a hex colour", () => {
    expect(readableTextColor(undefined)).toBeUndefined();
    expect(readableTextColor("red")).toBeUndefined();
  });
});

describe("isZipArchive", () => {
  it("accepts the OOXML zip magic and rejects anything else", () => {
    expect(isZipArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true);
    // "PK" alone is not enough — an empty-archive header carries no workbook.
    expect(isZipArchive(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(false);
    expect(isZipArchive(encode("plain text"))).toBe(false);
    expect(isZipArchive(new Uint8Array([]))).toBe(false);
  });
});

describe("parseSpreadsheetPreview: addressing", () => {
  it("keeps a cell in its real column when the data does not start at A", async () => {
    // THE bug this pins: a sheet whose used range is `E1:E…` must render its
    // content in column E with A–D empty. Normalising the range to column 0
    // moved everything to column A, so the letters in the header no longer
    // matched the file and a formula reference read wrong.
    const sheet = XLSX.utils.aoa_to_sheet([
      [null, null, null, null, "Assets type"],
      [null, null, null, null, "Solar Plates"],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet3");
    const bytes = new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));

    const { sheets } = await parseSpreadsheetPreview(bytes, live, "book.xlsx");

    expect(sheets[0].columnCount).toBe(5);
    expect(sheets[0].rows[0][4].text).toBe("Assets type");
    expect(sheets[0].rows[1][4].text).toBe("Solar Plates");
    // A through D stay empty rather than being shifted into.
    expect(sheets[0].rows[0].slice(0, 4).map((cell) => cell.text)).toEqual(["", "", "", ""]);
  });

  it("keeps a CSV's own column order", async () => {
    const { sheets } = await parseSpreadsheetPreview(encode(",,third"), live, "x.csv");
    expect(sheets[0].rows[0][2].text).toBe("third");
    expect(sheets[0].rows[0][0].text).toBe("");
  });
});

describe("parseSpreadsheetPreview: values", () => {
  it("reads a multi-sheet workbook, its values and its sheet names", async () => {
    const bytes = xlsxBytes({
      Data: [["Name", "Qty"], ["Widget", 12]],
      Summary: [["Total", 12]],
    });

    const { sheets } = await parseSpreadsheetPreview(bytes, live, "book.xlsx");

    expect(sheets.map((sheet) => sheet.name)).toEqual(["Data", "Summary"]);
    expect(sheets[0].rows[0].map((cell) => cell.text)).toEqual(["Name", "Qty"]);
    expect(sheets[0].rows[1].map((cell) => cell.text)).toEqual(["Widget", "12"]);
    expect(sheets[0].rows[1][1].kind).toBe("number");
    expect(sheets[0].truncated).toBe(false);
  });

  it("parses CSV with RFC 4180 quoting rather than splitting on commas", async () => {
    const { sheets } = await parseSpreadsheetPreview(
      encode('a,b\n"x,y",3\n"say ""hi""",4'),
      live,
      "export.csv",
    );

    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows[1][0].text).toBe("x,y");
    expect(sheets[0].rows[2][0].text).toBe('say "hi"');
    expect(sheets[0].rows[1][1].text).toBe("3");
  });

  it("decodes multi-byte CSV text instead of mangling it byte by byte", async () => {
    // SheetJS's binary path treats each byte as a character, which turns any
    // non-ASCII column into mojibake.
    const { sheets } = await parseSpreadsheetPreview(
      encode("name,label\nx,اردو 😀"),
      live,
      "utf8.csv",
    );
    expect(sheets[0].rows[1][1].text).toBe("اردو 😀");
  });

  it("names a CSV's single sheet after the file", async () => {
    const { sheets } = await parseSpreadsheetPreview(encode("a,b"), live, "export.csv");
    expect(sheets[0].name).toBe("export");
  });

  it("classifies a CSV by its bytes, not its extension", async () => {
    // A `.xlsx` that is really text still previews rather than erroring.
    const { sheets } = await parseSpreadsheetPreview(encode("a,b\n1,2"), live, "MIXED.XLSX");
    expect(sheets[0].rows[0].map((cell) => cell.text)).toEqual(["a", "b"]);
  });

  it("handles an empty sheet without throwing", async () => {
    // Excel has no truly zero-cell sheet, so this reports a minimal grid with
    // no content rather than no grid; `SpreadsheetPreview` turns that into the
    // "this spreadsheet is empty" state.
    const { sheets } = await parseSpreadsheetPreview(xlsxBytes({ Empty: [] }), live, "e.xlsx");
    expect(sheets).toHaveLength(1);
    expect(sheets[0].rows.flat().every((cell) => cell.kind === "empty")).toBe(true);
    expect(sheets[0].truncated).toBe(false);
  });

  it("rejects bytes that are neither a workbook nor readable text", async () => {
    // A zip that is not a workbook fails both parsers.
    const notAWorkbook = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    await expect(
      parseSpreadsheetPreview(notAWorkbook, live, "broken.xlsx"),
    ).rejects.toThrow(/could not be opened/i);
  });

  it("aborts before parsing when the request was already stale", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseSpreadsheetPreview(xlsxBytes({ S: [["a"]] }), controller.signal, "s.xlsx"),
    ).rejects.toThrow(/cancelled/i);
  });
});

describe("parseSpreadsheetPreview: truncation", () => {
  it("truncates columns past the cap and says so", async () => {
    const wide = [Array.from({ length: MAX_TABLE_COLUMNS + 10 }, (_, index) => index)];
    const { sheets } = await parseSpreadsheetPreview(xlsxBytes({ Wide: wide }), live, "wide.xlsx");

    expect(sheets[0].columnCount).toBe(MAX_TABLE_COLUMNS);
    expect(sheets[0].rows[0]).toHaveLength(MAX_TABLE_COLUMNS);
    expect(sheets[0].columnWidths).toHaveLength(MAX_TABLE_COLUMNS);
    // The flag drives the "showing the first N" notice, so an unreported
    // truncation would silently hide data.
    expect(sheets[0].truncated).toBe(true);
  });

  it("reports a width for every rendered column and a height for every row", async () => {
    const { sheets } = await parseSpreadsheetPreview(
      xlsxBytes({ S: [["a", "b", "c"], ["1", "2", "3"]] }),
      live,
      "s.xlsx",
    );
    expect(sheets[0].columnWidths).toHaveLength(sheets[0].columnCount);
    expect(sheets[0].rowHeights).toHaveLength(sheets[0].rows.length);
    for (const width of sheets[0].columnWidths) expect(width).toBeGreaterThan(0);
  });
});

/**
 * A styled workbook built in-process with ExcelJS's *writer*, then read back
 * through the parser. This used to run against a sample file on one
 * developer's disk and `skipIf`-ed everywhere else, which meant CI measured
 * the entire ExcelJS path — the reason that parser is preferred at all — as
 * untested. Everything asserted below is styling SheetJS does not report, so
 * a regression that silently drops to the fallback fails here.
 */
async function styledWorkbookBytes(): Promise<Uint8Array> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();

  const sheet = workbook.addWorksheet("Styled", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 2 }],
    properties: { defaultRowHeight: 18, defaultColWidth: 12 },
  });

  // Content starts at column E, so the "address from A, not from the first
  // used cell" rule stays under test on the ExcelJS path too.
  const title = sheet.getCell("E1");
  title.value = "Assets type";
  title.font = { bold: true, italic: true, underline: true, strike: true, size: 22, name: "Arial", color: { argb: "FFCC0000" } };
  title.alignment = { horizontal: "center", vertical: "middle", wrapText: true };

  // One cell per value kind ExcelJS can hand back.
  sheet.getCell("E2").value = 1234.5;
  sheet.getCell("E2").numFmt = "#,##0.00";
  sheet.getCell("F2").value = 45000;
  sheet.getCell("F2").numFmt = "yyyy-mm-dd"; // a number the format makes a date
  sheet.getCell("G2").value = new Date(Date.UTC(2026, 0, 15));
  sheet.getCell("H2").value = true;
  sheet.getCell("I2").value = false;
  sheet.getCell("J2").value = { richText: [{ text: "rich " }, { text: "text" }] };
  sheet.getCell("K2").value = { error: "#DIV/0!" };
  sheet.getCell("L2").value = { text: "Hippius", hyperlink: "https://example.com" };
  sheet.getCell("M2").value = { formula: "1+1", result: 2 };
  sheet.getCell("N2").value = "";

  // A solid fill that must survive, and a white one that must not: white is
  // the sheet's own paper and would blot out the alternating gridlines.
  sheet.getCell("E3").value = "filled";
  sheet.getCell("E3").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
  sheet.getCell("F3").value = "papered";
  sheet.getCell("F3").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };

  // Alignment variants, including the one Excel spells differently.
  sheet.getCell("E4").value = "left";
  sheet.getCell("E4").alignment = { horizontal: "left", vertical: "top" };
  sheet.getCell("F4").value = "right";
  sheet.getCell("F4").alignment = { horizontal: "right", vertical: "bottom" };
  sheet.getCell("G4").value = "spanning";
  sheet.getCell("G4").alignment = { horizontal: "centerContinuous" };
  sheet.getCell("H4").value = "justified";
  sheet.getCell("H4").alignment = { horizontal: "justify" }; // no mapping: left alone

  // A box drawn on ONE cell: its left/top edges must fold onto the
  // neighbours' right/bottom, or the box renders with two sides missing.
  sheet.getCell("F6").value = "boxed";
  sheet.getCell("F6").border = {
    top: { style: "thin", color: { argb: "FF000000" } },
    left: { style: "thin" },
    bottom: { style: "medium" },
    right: { style: "thin" },
  };

  sheet.mergeCells("E8:G8");
  sheet.getCell("E8").value = "merged heading";

  sheet.getColumn(5).width = 30;
  sheet.getColumn(6).hidden = true;
  sheet.getRow(10).height = 40;
  sheet.getRow(11).hidden = true;
  sheet.getCell("E11").value = "hidden row";

  const hidden = workbook.addWorksheet("Hidden");
  hidden.state = "hidden";
  hidden.getCell("A1").value = "not shown";

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

describe("parseSpreadsheetPreview: the ExcelJS path", () => {
  it("reads fonts, fills, alignment, borders and merges that SheetJS cannot", async () => {
    const { sheets } = await parseSpreadsheetPreview(await styledWorkbookBytes(), live, "styled.xlsx");

    // The hidden sheet is dropped, the visible one kept.
    expect(sheets.map((sheet) => sheet.name)).toEqual(["Styled"]);
    const [sheet] = sheets;

    const title = sheet.rows[0][4]; // column E, exactly where the file puts it
    expect(title.text).toBe("Assets type");
    expect(title.style).toMatchObject({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      fontFamily: "Arial",
      align: "center",
      valign: "middle",
      wrap: true,
      color: "#CC0000",
    });
    expect(title.style?.fontSize).toBeGreaterThan(20);
    // Columns A-D are empty but present, so E stays column E.
    expect(sheet.rows[0].slice(0, 4).every((cell) => cell.text === "")).toBe(true);

    // Frozen panes come only from this parser.
    expect(sheet.frozenRows).toBe(2);
    expect(sheet.frozenColumns).toBe(1);
  });

  it("classifies every value kind ExcelJS reports", async () => {
    const { sheets } = await parseSpreadsheetPreview(await styledWorkbookBytes(), live, "styled.xlsx");
    const row = sheets[0].rows[1];

    expect(row[4]).toMatchObject({ kind: "number", text: "1,234.50" });
    // A number under a date format is a date, not a number.
    expect(row[5].kind).toBe("date");
    expect(row[6].kind).toBe("date");
    expect(row[7]).toMatchObject({ kind: "bool", text: "TRUE" });
    expect(row[8]).toMatchObject({ kind: "bool", text: "FALSE" });
    expect(row[9]).toMatchObject({ kind: "text", text: "rich text" });
    expect(row[10]).toMatchObject({ kind: "error", text: "#DIV/0!" });
    expect(row[12]).toMatchObject({ kind: "number", text: "2" });
    // An empty string is an empty cell, not a blank text cell.
    expect(row[13].kind).toBe("empty");

    // A hyperlink is underlined and coloured so it reads as one.
    expect(row[11].text).toBe("Hippius");
    expect(row[11].style?.underline).toBe(true);
    expect(row[11].style?.color).toBe("#1155CC");
  });

  it("keeps a real fill but discards a white one", async () => {
    const { sheets } = await parseSpreadsheetPreview(await styledWorkbookBytes(), live, "styled.xlsx");
    const row = sheets[0].rows[2];

    expect(row[4].style?.fill).toBe("#1F3864");
    expect(row[5].style?.fill).toBeUndefined();
  });

  it("maps the alignments it understands and leaves the rest alone", async () => {
    const { sheets } = await parseSpreadsheetPreview(await styledWorkbookBytes(), live, "styled.xlsx");
    const row = sheets[0].rows[3];

    expect(row[4].style).toMatchObject({ align: "left", valign: "top" });
    expect(row[5].style).toMatchObject({ align: "right", valign: "bottom" });
    expect(row[6].style?.align).toBe("center"); // centerContinuous
    expect(row[7].style?.align).toBeUndefined(); // justify has no mapping
  });

  it("folds a cell's left and top edges onto its neighbours", async () => {
    const { sheets } = await parseSpreadsheetPreview(await styledWorkbookBytes(), live, "styled.xlsx");
    const rows = sheets[0].rows;

    // The boxed cell keeps its own right/bottom...
    expect(rows[5][5].style?.borderRight?.width).toBeGreaterThan(0);
    expect(rows[5][5].style?.borderBottom?.width).toBeGreaterThan(0);
    // ...and its left/top are drawn by the neighbours that own those edges.
    expect(rows[5][4].style?.borderRight?.width).toBeGreaterThan(0);
    expect(rows[4][5].style?.borderBottom?.width).toBeGreaterThan(0);
    // A medium border is thicker than a thin one.
    expect(rows[5][5].style?.borderBottom?.width).toBeGreaterThan(
      rows[5][5].style?.borderRight?.width ?? 0,
    );
  });

  it("spans a merged range and marks the cells it covers", async () => {
    const { sheets } = await parseSpreadsheetPreview(await styledWorkbookBytes(), live, "styled.xlsx");
    const anchor = sheets[0].rows[7][4];

    expect(anchor.text).toBe("merged heading");
    expect(anchor.colSpan).toBe(3);
    expect(sheets[0].rows[7][5].covered).toBe(true);
    expect(sheets[0].rows[7][6].covered).toBe(true);
    expect(sheets[0].merges).toContainEqual({ r0: 7, c0: 4, r1: 7, c1: 6 });
  });

  it("reports explicit, default and hidden sizing", async () => {
    const { sheets } = await parseSpreadsheetPreview(await styledWorkbookBytes(), live, "styled.xlsx");
    const sheet = sheets[0];

    expect(sheet.columnWidths[4]).toBeGreaterThan(sheet.columnWidths[0]); // width 30
    expect(sheet.columnWidths[5]).toBe(0); // hidden column
    expect(sheet.columnWidths[0]).toBe(excelColumnWidthToPixels(12)); // defaultColWidth
    expect(sheet.rowHeights[9]).toBe(pointsToPixels(40)); // explicit height
    expect(sheet.rowHeights[10]).toBe(0); // hidden row
    expect(sheet.rowHeights[0]).toBe(pointsToPixels(18)); // defaultRowHeight
  });
});
