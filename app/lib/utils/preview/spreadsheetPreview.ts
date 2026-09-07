/**
 * Turns an XLSX or CSV file into the grid model rendered by `SpreadsheetGrid`.
 *
 * **Two parsers, deliberately.** ExcelJS is tried first for XLSX because it is
 * the only one of the two that exposes fonts, borders, alignment, merges,
 * column widths, row heights and frozen panes — without it a styled workbook
 * previews as unstyled text in column A. ExcelJS also rejects some valid
 * files (notably namespace-prefixed OOXML from certain generators), where it
 * returns an empty model rather than throwing, so SheetJS is the fallback:
 * more tolerant, but values and fills only. CSV always uses SheetJS.
 *
 * Neither path re-implements OOXML.
 *
 * DOM-free apart from the theme-part `DOMParser`, so the addressing and
 * truncation rules below are directly unit-testable.
 */

import type { CellObject, ColInfo, RowInfo, WorkBook, WorkSheet } from "xlsx";
import type { Borders, Cell, CellValue, Workbook, Worksheet } from "exceljs";

import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_THEME_COLORS,
  EMPTY_CELL,
  EXCEL_DEFAULT_COLUMN_WIDTH,
  MAX_TABLE_ROWS,
  borderStyleWidth,
  clampExtent,
  excelColumnWidthToPixels,
  normalizeHexColor,
  orderThemePalette,
  pointsToPixels,
  readableTextColor,
  resolveColor,
  type CellBorder,
  type CellKind,
  type CellStyle,
  type MergedRange,
  type SpreadsheetCell,
  type SpreadsheetPreviewData,
  type SpreadsheetSheet,
  type StyleColor,
} from "./spreadsheetFormat";

export * from "./spreadsheetFormat";

type SheetJs = typeof import("xlsx");
type ExcelJs = typeof import("exceljs");

function abortError(): DOMException {
  return new DOMException("Preview cancelled", "AbortError");
}

/**
 * True when the bytes start with the ZIP local-file-header magic (`PK\x03\x04`).
 *
 * Every OOXML file is a zip archive, and this is also how a CSV is told from a
 * workbook. The check matters because SheetJS's reader sniffs its input and
 * will happily parse arbitrary bytes as delimited text: without it, a `.xlsx`
 * that is not really a workbook renders as a confident one-cell "spreadsheet"
 * of its own raw contents instead of the honest error state.
 */
export function isZipArchive(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function formatNumber(value: number, numFmt: string | undefined, xlsx: SheetJs): string {
  try {
    return xlsx.SSF.format(numFmt?.trim() || "General", value);
  } catch {
    return String(value);
  }
}

function formatDate(value: Date, numFmt: string | undefined, xlsx: SheetJs): string {
  if (Number.isNaN(value.getTime())) return "";
  try {
    return xlsx.SSF.format(numFmt?.trim() || "yyyy-mm-dd", value);
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

/** Reads `<a:clrScheme>` from a theme part; ExcelJS keeps it as raw XML. */
function paletteFromThemeXml(xml: string | undefined): string[] {
  if (!xml || typeof DOMParser === "undefined") return DEFAULT_THEME_COLORS;
  try {
    const document = new DOMParser().parseFromString(xml, "text/xml");
    const scheme = document.getElementsByTagNameNS("*", "clrScheme").item(0);
    if (!scheme) return DEFAULT_THEME_COLORS;
    const colors = Array.from(scheme.children).map((slot) => {
      const value = slot.firstElementChild;
      if (!value) return null;
      return normalizeHexColor(
        value.localName === "sysClr"
          ? value.getAttribute("lastClr")
          : value.getAttribute("val"),
      );
    });
    return colors.length >= 12 ? orderThemePalette(colors) : DEFAULT_THEME_COLORS;
  } catch {
    return DEFAULT_THEME_COLORS;
  }
}

function paletteFromSheetJs(workbook: WorkBook): string[] {
  const scheme = (
    workbook as unknown as {
      Themes?: { themeElements?: { clrScheme?: Array<{ rgb?: string }> } };
    }
  ).Themes?.themeElements?.clrScheme;
  if (!scheme || scheme.length < 12) return DEFAULT_THEME_COLORS;
  return orderThemePalette(scheme.map((entry) => normalizeHexColor(entry.rgb)));
}

// ---------------------------------------------------------------------------
// Shared post-processing
// ---------------------------------------------------------------------------

interface PendingBorders {
  right?: CellBorder;
  bottom?: CellBorder;
  left?: CellBorder;
  top?: CellBorder;
}

/**
 * Only right/bottom edges are drawn, so a cell's left/top border becomes the
 * neighbour's right/bottom when that neighbour has none of its own. Without
 * this, a box drawn around a range shows only two of its four sides.
 */
function foldBorders(
  rows: SpreadsheetCell[][],
  borders: Array<Array<PendingBorders | undefined>>,
): void {
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      const own = borders[r]?.[c];
      if (!own) continue;
      if (own.left && c > 0) {
        const neighbour = (borders[r][c - 1] ??= {});
        neighbour.right ??= own.left;
      }
      if (own.top && r > 0) {
        const neighbour = (borders[r - 1][c] ??= {});
        neighbour.bottom ??= own.top;
      }
    }
  }
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      const own = borders[r]?.[c];
      if (!own?.right && !own?.bottom) continue;
      const cell = rows[r][c];
      rows[r][c] = {
        ...cell,
        style: { ...cell.style, borderRight: own.right, borderBottom: own.bottom },
      };
    }
  }
}

/** Marks merged ranges: span on the anchor, `covered` on everything it eats. */
function applyMerges(rows: SpreadsheetCell[][], merges: MergedRange[]): void {
  for (const merge of merges) {
    const anchor = rows[merge.r0]?.[merge.c0];
    if (!anchor) continue;
    const endRow = Math.min(merge.r1, rows.length - 1);
    const endColumn = Math.min(merge.c1, (rows[0]?.length ?? 1) - 1);
    if (endRow === merge.r0 && endColumn === merge.c0) continue;
    rows[merge.r0][merge.c0] = {
      ...anchor,
      colSpan: endColumn - merge.c0 + 1,
      rowSpan: endRow - merge.r0 + 1,
    };
    for (let r = merge.r0; r <= endRow; r += 1) {
      for (let c = merge.c0; c <= endColumn; c += 1) {
        if (r === merge.r0 && c === merge.c0) continue;
        if (rows[r]?.[c]) rows[r][c] = { ...EMPTY_CELL, covered: true };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ExcelJS path (styled XLSX)
// ---------------------------------------------------------------------------

type ExcelCellValue = Exclude<CellValue, null | undefined>;

function excelBorder(
  side: Borders[keyof Borders] | undefined,
  palette: string[],
): CellBorder | undefined {
  const width = borderStyleWidth(side?.style);
  if (!side || width === 0) return undefined;
  return {
    width,
    color: resolveColor(side.color as StyleColor | undefined, palette) ?? "#000000",
  };
}

function excelCell(
  cell: Cell,
  excel: ExcelJs,
  xlsx: SheetJs,
  palette: string[],
  borders: PendingBorders,
): SpreadsheetCell {
  const { ValueType } = excel;
  const type = cell.effectiveType ?? cell.type;
  const value: ExcelCellValue | null | undefined =
    type === ValueType.Formula || cell.type === ValueType.Formula
      ? (cell.result as ExcelCellValue | null | undefined)
      : cell.value;

  let kind: CellKind = "empty";
  let text = "";
  let isLink = false;
  if (value instanceof Date) {
    kind = "date";
    text = formatDate(value, cell.numFmt, xlsx);
  } else if (typeof value === "number") {
    kind = xlsx.SSF.is_date(cell.numFmt ?? "") ? "date" : "number";
    text = formatNumber(value, cell.numFmt, xlsx);
  } else if (typeof value === "boolean") {
    kind = "bool";
    text = value ? "TRUE" : "FALSE";
  } else if (typeof value === "string") {
    kind = value ? "text" : "empty";
    text = value;
  } else if (value && typeof value === "object") {
    if ("richText" in value) {
      text = value.richText.map((run) => run.text).join("");
      kind = text ? "text" : "empty";
    } else if ("error" in value) {
      kind = "error";
      text = String(value.error);
    } else if ("hyperlink" in value) {
      isLink = true;
      const inner = value.text as unknown as
        | string
        | { richText?: Array<{ text: string }> }
        | undefined;
      text =
        typeof inner === "string"
          ? inner
          : inner?.richText
            ? inner.richText.map((run) => run.text).join("")
            : String(value.hyperlink ?? "");
      kind = text ? "text" : "empty";
    } else if ("formula" in value || "sharedFormula" in value) {
      const result = (value as { result?: ExcelCellValue }).result;
      if (typeof result === "number") {
        kind = "number";
        text = formatNumber(result, cell.numFmt, xlsx);
      } else if (result instanceof Date) {
        kind = "date";
        text = formatDate(result, cell.numFmt, xlsx);
      } else if (result != null) {
        text = String(result);
        kind = text ? "text" : "empty";
      }
    }
  }

  const style: CellStyle = {};
  const fill = cell.fill;
  if (fill && fill.type === "pattern" && fill.pattern !== "none") {
    const color =
      resolveColor(fill.fgColor as StyleColor | undefined, palette) ??
      resolveColor(fill.bgColor as StyleColor | undefined, palette);
    // A white fill is the sheet's own paper; keeping it would defeat the
    // alternating gridlines underneath.
    if (color && color !== "#FFFFFF") style.fill = color;
  }

  const font = cell.font;
  if (font) {
    if (font.bold) style.bold = true;
    if (font.italic) style.italic = true;
    if (font.underline) style.underline = true;
    if (font.strike) style.strike = true;
    if (font.name) style.fontFamily = font.name;
    if (typeof font.size === "number" && font.size > 0) {
      style.fontSize = pointsToPixels(font.size);
    }
    const color = resolveColor(font.color as StyleColor | undefined, palette);
    if (color) style.color = color;
  }
  if (isLink) {
    style.underline = true;
    style.color ??= "#1155CC";
  }

  const alignment = cell.alignment;
  if (alignment) {
    switch (alignment.horizontal) {
      case "left":
      case "center":
      case "right":
        style.align = alignment.horizontal;
        break;
      case "centerContinuous":
        style.align = "center";
        break;
      default:
        break;
    }
    switch (alignment.vertical) {
      case "top":
      case "middle":
      case "bottom":
        style.valign = alignment.vertical;
        break;
      default:
        break;
    }
    if (alignment.wrapText) style.wrap = true;
  }

  const border = cell.border;
  if (border) {
    borders.right = excelBorder(border.right, palette);
    borders.bottom = excelBorder(border.bottom, palette);
    borders.left = excelBorder(border.left, palette);
    borders.top = excelBorder(border.top, palette);
  }

  if (kind === "empty" && Object.keys(style).length === 0) return EMPTY_CELL;
  return Object.keys(style).length > 0 ? { text, kind, style } : { text, kind };
}

function excelSheet(
  worksheet: Worksheet,
  excel: ExcelJs,
  xlsx: SheetJs,
  palette: string[],
  signal: AbortSignal,
): SpreadsheetSheet {
  const dimensions = worksheet.dimensions;
  // Addressed from row 1 / column A, never from where the data happens to
  // start: a sheet whose content begins at E1 must still show it in column E.
  const lastRow = Math.max(worksheet.rowCount, dimensions?.bottom ?? 0);
  const lastColumn = Math.max(worksheet.columnCount, dimensions?.right ?? 0);
  const extent = clampExtent(lastRow, lastColumn);
  const { rowCount, columnCount } = extent;

  const defaultRowHeight = worksheet.properties?.defaultRowHeight
    ? pointsToPixels(worksheet.properties.defaultRowHeight)
    : DEFAULT_ROW_HEIGHT;
  const defaultColumnWidth = worksheet.properties?.defaultColWidth
    ? excelColumnWidthToPixels(worksheet.properties.defaultColWidth)
    : EXCEL_DEFAULT_COLUMN_WIDTH;

  const rows: SpreadsheetCell[][] = [];
  const rowHeights: number[] = [];
  const borders: Array<Array<PendingBorders | undefined>> = [];

  for (let r = 1; r <= rowCount; r += 1) {
    // Cancellation is checked periodically rather than per row: a 50k-row
    // sheet must not keep parsing after the user moved to the next file.
    if (r % 500 === 0 && signal.aborted) throw abortError();
    const row = worksheet.getRow(r);
    const cells: SpreadsheetCell[] = new Array<SpreadsheetCell>(columnCount).fill(EMPTY_CELL);
    const rowBorders: Array<PendingBorders | undefined> = new Array(columnCount);
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      if (columnNumber > columnCount) return;
      const pending: PendingBorders = {};
      cells[columnNumber - 1] = excelCell(cell, excel, xlsx, palette, pending);
      if (pending.right || pending.bottom || pending.left || pending.top) {
        rowBorders[columnNumber - 1] = pending;
      }
    });
    rows.push(cells);
    borders.push(rowBorders);
    rowHeights.push(
      row.hidden
        ? 0
        : typeof row.height === "number" && row.height > 0
          ? pointsToPixels(row.height)
          : defaultRowHeight,
    );
  }

  const columnWidths = Array.from({ length: columnCount }, (_, index) => {
    const column = worksheet.getColumn(index + 1);
    if (column.hidden) return 0;
    return typeof column.width === "number" && column.width > 0
      ? excelColumnWidthToPixels(column.width)
      : defaultColumnWidth;
  });

  const merges: MergedRange[] = (
    (worksheet.model as { merges?: string[] }).merges ?? []
  ).flatMap((reference) => {
    try {
      const range = xlsx.utils.decode_range(reference);
      return [{ r0: range.s.r, c0: range.s.c, r1: range.e.r, c1: range.e.c }];
    } catch {
      return [];
    }
  });
  applyMerges(rows, merges);
  foldBorders(rows, borders);

  const view = worksheet.views?.[0];
  const frozen = view && view.state === "frozen";
  return {
    name: worksheet.name,
    rows,
    rowHeights,
    columnCount,
    columnWidths,
    merges,
    frozenRows: frozen ? Math.min(view.ySplit ?? 0, rowCount) : 0,
    frozenColumns: frozen ? Math.min(view.xSplit ?? 0, columnCount) : 0,
    truncated: extent.truncated,
  };
}

async function parseWithExcelJs(
  bytes: Uint8Array,
  xlsx: SheetJs,
  signal: AbortSignal,
): Promise<SpreadsheetPreviewData> {
  const loaded = (await import("exceljs")) as ExcelJs & { default?: ExcelJs };
  // The browser build is namespaced under `default` in some bundlers.
  const excel = loaded.Workbook ? loaded : (loaded.default ?? loaded);
  if (signal.aborted) throw abortError();

  const workbook: Workbook = new excel.Workbook();
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  if (signal.aborted) throw abortError();

  // Typed as `string[]`, but at runtime ExcelJS keys theme parts by name.
  const themes = (workbook.model as unknown as {
    themes?: Record<string, string> | string[];
  }).themes;
  const themeXml = Array.isArray(themes) ? themes[0] : themes?.theme1;
  const palette = paletteFromThemeXml(themeXml);

  const worksheets = workbook.worksheets.filter(
    (worksheet) => worksheet.state === "visible" || !worksheet.state,
  );
  const visible = worksheets.length > 0 ? worksheets : workbook.worksheets;
  // ExcelJS reports an unreadable workbook as an empty one rather than
  // throwing, so an empty result must fall through to SheetJS instead of
  // rendering as a blank grid.
  if (visible.length === 0) throw new Error("This workbook has no sheets.");

  return {
    sheets: visible.map((worksheet) => excelSheet(worksheet, excel, xlsx, palette, signal)),
  };
}

// ---------------------------------------------------------------------------
// SheetJS path (CSV, and the fallback for files ExcelJS rejects)
// ---------------------------------------------------------------------------

/** SheetJS cell type letter → the kind the grid aligns and colours by. */
export function cellKindFromType(
  type: string | undefined,
  numberFormat?: string,
  isDateFormat?: (format: string) => boolean,
): CellKind {
  switch (type) {
    case "n":
      return numberFormat && isDateFormat?.(numberFormat) ? "date" : "number";
    case "d":
      return "date";
    case "b":
      return "bool";
    case "e":
      return "error";
    case "s":
    case "str":
      return "text";
    default:
      return "empty";
  }
}

function sheetJsCell(
  cell: CellObject | undefined,
  xlsx: SheetJs,
  palette: string[],
): SpreadsheetCell {
  if (!cell || cell.t === "z") return EMPTY_CELL;

  // `t` is widened because SheetJS also emits the internal "str" (formula
  // string result) letter, which its published `ExcelDataType` union omits.
  const type: string = cell.t;
  const kind =
    type === "s" || type === "str"
      ? cell.v === "" || cell.v == null
        ? "empty"
        : "text"
      : cellKindFromType(cell.t, cell.z ? String(cell.z) : undefined, (f) =>
          xlsx.SSF.is_date(f),
        );

  // `w` is SheetJS's formatted value — the file's own number format already
  // applied — so it is preferred over the raw value whenever present.
  let text: string;
  if (typeof cell.w === "string") text = cell.w;
  else if (cell.v == null) text = "";
  else if (cell.t === "n" && typeof cell.v === "number") {
    text = formatNumber(cell.v, cell.z ? String(cell.z) : undefined, xlsx);
  } else if (cell.v instanceof Date) text = formatDate(cell.v, undefined, xlsx);
  else text = String(cell.v);

  if (kind === "empty" && !text) return EMPTY_CELL;

  const raw = (cell as CellObject & {
    s?: { patternType?: string; fgColor?: StyleColor; bgColor?: StyleColor };
  }).s;
  let style: CellStyle | undefined;
  if (raw?.patternType && raw.patternType !== "none") {
    const fill = resolveColor(raw.fgColor, palette) ?? resolveColor(raw.bgColor, palette);
    if (fill && fill !== "#FFFFFF") {
      // This path has no font colour, so a dark fill needs one derived.
      style = { fill, color: readableTextColor(fill) };
    }
  }
  return style ? { text, kind, style } : { text, kind };
}

function sheetJsColumnWidths(
  columns: ColInfo[] | undefined,
  count: number,
  fallback: number,
): number[] {
  return Array.from({ length: count }, (_, index) => {
    const info = columns?.[index];
    if (!info) return fallback;
    if (info.hidden) return 0;
    if (typeof info.wpx === "number" && info.wpx > 0) return Math.round(info.wpx);
    if (typeof info.width === "number" && info.width > 0) {
      return excelColumnWidthToPixels(info.width);
    }
    if (typeof info.wch === "number" && info.wch > 0) {
      return excelColumnWidthToPixels(info.wch);
    }
    return fallback;
  });
}

function sheetJsRowHeights(rows: RowInfo[] | undefined, count: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const info = rows?.[index];
    if (!info) return DEFAULT_ROW_HEIGHT;
    if (info.hidden) return 0;
    if (typeof info.hpx === "number" && info.hpx > 0) return Math.round(info.hpx);
    if (typeof info.hpt === "number" && info.hpt > 0) return pointsToPixels(info.hpt);
    return DEFAULT_ROW_HEIGHT;
  });
}

function sheetJsSheet(
  name: string,
  sheet: WorkSheet,
  xlsx: SheetJs,
  palette: string[],
  isCsv: boolean,
): SpreadsheetSheet {
  const ref = sheet["!ref"];
  const range = ref ? xlsx.utils.decode_range(ref) : null;
  // `e.r + 1` / `e.c + 1`, NOT the width of the used range: a sheet whose
  // `!ref` is `E1:E1000` must render its content in column E with A–D empty.
  // Normalising the range to column 0 was what moved it to column A.
  const extent = clampExtent(range ? range.e.r + 1 : 0, range ? range.e.c + 1 : 0);
  const { rowCount, columnCount } = extent;

  const data = sheet["!data"];
  const rows = Array.from({ length: rowCount }, (_, r) =>
    Array.from({ length: columnCount }, (_, c) => {
      const cell = data
        ? data[r]?.[c]
        : (sheet[xlsx.utils.encode_cell({ r, c })] as CellObject | undefined);
      return sheetJsCell(cell, xlsx, palette);
    }),
  );
  const merges: MergedRange[] = (sheet["!merges"] ?? []).map((merge) => ({
    r0: merge.s.r,
    c0: merge.s.c,
    r1: merge.e.r,
    c1: merge.e.c,
  }));
  applyMerges(rows, merges);

  return {
    name,
    rows,
    rowHeights: sheetJsRowHeights(sheet["!rows"], rowCount),
    columnCount,
    columnWidths: sheetJsColumnWidths(
      sheet["!cols"],
      columnCount,
      isCsv ? DEFAULT_COLUMN_WIDTH : EXCEL_DEFAULT_COLUMN_WIDTH,
    ),
    merges,
    // SheetJS does not populate `!freeze` when reading, so this path reports
    // no frozen panes rather than guessing at them.
    frozenRows: 0,
    frozenColumns: 0,
    truncated: extent.truncated,
  };
}

function parseWithSheetJs(
  bytes: Uint8Array,
  xlsx: SheetJs,
  isCsv: boolean,
  filename: string,
): SpreadsheetPreviewData {
  const common = {
    cellStyles: true,
    cellNF: true,
    dense: true,
    sheetRows: MAX_TABLE_ROWS + 1,
  } as const;
  let workbook: WorkBook;
  try {
    if (isCsv) {
      // Decoded here rather than by SheetJS: its binary path treats each byte
      // as a character, which mangles any multi-byte text.
      const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
      workbook = xlsx.read(text, { ...common, type: "string", raw: false });
    } else {
      workbook = xlsx.read(bytes, { ...common, type: "array" });
    }
  } catch {
    throw new Error(
      isCsv ? "This CSV file could not be read." : "This spreadsheet could not be opened.",
    );
  }

  const palette = paletteFromSheetJs(workbook);
  const hiddenFlags = workbook.Workbook?.Sheets ?? [];
  const visibleNames = workbook.SheetNames.filter(
    (_, index) => !hiddenFlags[index]?.Hidden,
  );
  const names = visibleNames.length > 0 ? visibleNames : workbook.SheetNames;
  if (names.length === 0) throw new Error("This spreadsheet has no sheets.");
  const csvName = filename.replace(/\.[^.]+$/, "") || "Sheet1";

  return {
    sheets: names.map((name) =>
      sheetJsSheet(isCsv ? csvName : name, workbook.Sheets[name] ?? {}, xlsx, palette, isCsv),
    ),
  };
}

/**
 * Parse XLSX or CSV bytes into the preview grid.
 *
 * The format is decided by the bytes (zip magic) rather than the filename, so
 * a `.xlsx` that is really a CSV still previews and a mislabelled binary does
 * not reach the XLSX reader.
 */
export async function parseSpreadsheetPreview(
  bytes: Uint8Array,
  signal: AbortSignal,
  /** Used to name the single sheet a CSV produces. */
  filename = "",
): Promise<SpreadsheetPreviewData> {
  const xlsx = await import("xlsx");
  if (signal.aborted) throw abortError();

  const isCsv = !isZipArchive(bytes);
  if (!isCsv) {
    try {
      return await parseWithExcelJs(bytes, xlsx, signal);
    } catch (error) {
      // A cancelled parse is not a parser failure and must not fall through to
      // a second full parse of a file the user already navigated away from.
      if (signal.aborted) throw error;
      // ExcelJS rejects some valid files; SheetJS is more tolerant.
    }
  }
  if (signal.aborted) throw abortError();
  return parseWithSheetJs(bytes, xlsx, isCsv, filename);
}
