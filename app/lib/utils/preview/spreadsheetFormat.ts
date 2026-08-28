/**
 * DOM-free shapes and geometry/colour helpers for spreadsheet previews.
 *
 * Parsing itself lives in `spreadsheetPreview.ts`; everything here is pure, so
 * the unit conversions and the OOXML colour model (theme + indexed palettes,
 * tints) are testable without a workbook.
 */

export type CellKind = "empty" | "text" | "number" | "date" | "bool" | "error";

export interface CellBorder {
  /** CSS colour. */
  color: string;
  /** Pixel width. */
  width: number;
}

export interface CellStyle {
  /** CSS colour for the cell background. */
  fill?: string;
  /** CSS text colour. */
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Font family exactly as stored in the file (fallbacks added at render). */
  fontFamily?: string;
  /** Font size in pixels. */
  fontSize?: number;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  wrap?: boolean;
  /** Only right/bottom are drawn; parsers fold neighbours' left/top into them. */
  borderRight?: CellBorder;
  borderBottom?: CellBorder;
}

export interface SpreadsheetCell {
  /** Display text, already number-formatted by the file's own format string. */
  text: string;
  kind: CellKind;
  style?: CellStyle;
  /** Set on the anchor cell of a merged range. */
  colSpan?: number;
  rowSpan?: number;
  /** True for cells swallowed by a merged range; they render nothing. */
  covered?: boolean;
}

export interface MergedRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface SpreadsheetSheet {
  name: string;
  /** Dense grid, addressed from row 0 / column A of the sheet, not of its data. */
  rows: SpreadsheetCell[][];
  /** Pixel heights; `0` means the row is hidden. */
  rowHeights: number[];
  columnCount: number;
  /** Pixel widths; `0` means the column is hidden. */
  columnWidths: number[];
  merges: MergedRange[];
  frozenRows: number;
  frozenColumns: number;
  truncated: boolean;
}

export interface SpreadsheetPreviewData {
  sheets: SpreadsheetSheet[];
}

/**
 * Ceilings on what one sheet may occupy.
 *
 * The grid virtualises rows, so the row ceiling bounds the parsed model in
 * memory rather than the DOM and can be generous enough that ordinary sheets
 * are never cut. Columns are NOT virtualised — every column renders on every
 * visible row — so that ceiling is the one bounding the DOM and stays tighter.
 */
export const MAX_TABLE_ROWS = 50_000;
export const MAX_TABLE_COLUMNS = 200;

/** Google Sheets' defaults, used when a file specifies none of its own. */
export const DEFAULT_COLUMN_WIDTH = 100;
export const DEFAULT_ROW_HEIGHT = 21;
/** Excel's default column width (8.43 characters) in pixels. */
export const EXCEL_DEFAULT_COLUMN_WIDTH = 64;

export const EMPTY_CELL: SpreadsheetCell = Object.freeze({
  text: "",
  kind: "empty",
});

/** `0 → "A"`, `25 → "Z"`, `26 → "AA"` — the spreadsheet column header. */
export function columnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

/** Excel stores column widths in characters of the default font. */
export function excelColumnWidthToPixels(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.max(4, Math.round(width * 7 + 5));
}

export function pointsToPixels(points: number): number {
  return Math.round((points * 96) / 72);
}

/** OOXML border style → pixel width. */
export function borderStyleWidth(style: string | undefined): number {
  switch (style) {
    case undefined:
    case "none":
      return 0;
    case "medium":
    case "mediumDashed":
    case "mediumDashDot":
    case "mediumDashDotDot":
    case "double":
      return 2;
    case "thick":
      return 3;
    default:
      return 1;
  }
}

/**
 * How many empty rows/columns to append so the gridlines reach the edge of the
 * viewer.
 *
 * Google Sheets never ends its grid where the data ends; without this the
 * preview reads as an HTML table floating on a page. One extra unit is added
 * so a partially visible row/column still draws its line at the boundary.
 *
 * Pure because the grid measures its viewport with a `ResizeObserver`, which
 * reports 0 in a DOM without layout — so this rule is verified here rather
 * than through the rendered output.
 */
export function viewportFillCount(
  availablePx: number,
  usedPx: number,
  unitPx: number,
): number {
  if (!Number.isFinite(availablePx) || unitPx <= 0) return 0;
  return Math.max(0, Math.ceil((availablePx - usedPx) / unitPx) + 1);
}

/** Clamp a sheet's declared extent to the render caps. */
export function clampExtent(
  rowCount: number,
  columnCount: number,
): { rowCount: number; columnCount: number; truncated: boolean } {
  const rows = Math.max(0, Math.min(rowCount, MAX_TABLE_ROWS));
  const columns = Math.max(0, Math.min(columnCount, MAX_TABLE_COLUMNS));
  return {
    rowCount: rows,
    columnCount: columns,
    truncated: rowCount > rows || columnCount > columns,
  };
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Legacy 56-colour palette (indices 8–63); 0–7 mirror the first entries. */
export const INDEXED_COLORS: string[] = [
  "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
  "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
  "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#C0C0C0", "#808080",
  "#9999FF", "#993366", "#FFFFCC", "#CCFFFF", "#660066", "#FF8080", "#0066CC", "#CCCCFF",
  "#000080", "#FF00FF", "#FFFF00", "#00FFFF", "#800080", "#800000", "#008080", "#0000FF",
  "#00CCFF", "#CCFFFF", "#CCFFCC", "#FFFF99", "#99CCFF", "#FF99CC", "#CC99FF", "#FFCC99",
  "#3366FF", "#33CCCC", "#99CC00", "#FFCC00", "#FF9900", "#FF6600", "#666699", "#969696",
  "#003366", "#339966", "#003300", "#333300", "#993300", "#993366", "#333399", "#333333",
];

/**
 * Office 2007+ default theme in Excel's `theme="n"` order (0 = lt1, 1 = dk1,
 * 2 = lt2, 3 = dk2, then accent1–6, hlink, folHlink).
 */
export const DEFAULT_THEME_COLORS: string[] = [
  "#FFFFFF", "#000000", "#EEECE1", "#1F497D",
  "#4F81BD", "#C0504D", "#9BBB59", "#8064A2",
  "#4BACC6", "#F79646", "#0000FF", "#800080",
];

export function normalizeHexColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.trim().replace(/^#/, "").toUpperCase();
  // ARGB (8 chars) drops its alpha; anything else must be a plain RRGGBB.
  if (/^[0-9A-F]{8}$/.test(hex)) return `#${hex.slice(2)}`;
  if (/^[0-9A-F]{6}$/.test(hex)) return `#${hex}`;
  return null;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return [hue / 6, saturation, lightness];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/** Applies an OOXML `tint` (-1…1) to a hex colour the way Excel does. */
export function applyTint(hex: string, tint: number): string {
  if (!tint || !Number.isFinite(tint)) return hex;
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const lightness = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return rgbToHex(hslToRgb([h, s, Math.max(0, Math.min(1, lightness))]));
}

/** A colour reference as either parser reports it. */
export interface StyleColor {
  argb?: string;
  rgb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
}

/** Resolve an OOXML colour reference against the workbook's theme palette. */
export function resolveColor(
  color: StyleColor | undefined,
  palette: string[],
): string | null {
  if (!color) return null;
  let hex = normalizeHexColor(color.argb ?? color.rgb);
  if (!hex && typeof color.theme === "number") hex = palette[color.theme] ?? null;
  if (!hex && typeof color.indexed === "number") {
    hex = INDEXED_COLORS[color.indexed] ?? null;
  }
  if (!hex) return null;
  return typeof color.tint === "number" ? applyTint(hex, color.tint) : hex;
}

/** Excel's `theme="n"` index order swaps the first two pairs of the part. */
export function orderThemePalette(partOrder: Array<string | null>): string[] {
  const ordered = [
    partOrder[1], partOrder[0], partOrder[3], partOrder[2],
    ...partOrder.slice(4, 12),
  ];
  return ordered.map((color, index) => color ?? DEFAULT_THEME_COLORS[index]);
}

/**
 * A text colour that stays legible on `fill`.
 *
 * Only used on the SheetJS fallback path, which reports a cell's fill but not
 * its font colour: a dark header fill would otherwise render near-black text
 * on a near-black background. The ExcelJS path has the real font colour and
 * does not need this. Relative luminance is the sRGB formula.
 */
export function readableTextColor(fill: string | undefined): string | undefined {
  if (!fill || !/^#[0-9A-F]{6}$/i.test(fill)) return undefined;
  const red = parseInt(fill.slice(1, 3), 16) / 255;
  const green = parseInt(fill.slice(3, 5), 16) / 255;
  const blue = parseInt(fill.slice(5, 7), 16) / 255;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance < 0.55 ? "#FFFFFF" : undefined;
}
