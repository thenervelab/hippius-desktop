"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  EMPTY_CELL,
  columnLabel,
  viewportFillCount,
  type SpreadsheetCell,
  type SpreadsheetSheet,
} from "@/app/lib/utils/preview/spreadsheetFormat";

const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 24;
/** Rows rendered above/below the viewport so scrolling never shows gaps. */
const OVERSCAN_PX = 600;

/**
 * Google Sheets' own chrome colours, hard-coded rather than themed.
 *
 * A spreadsheet is a document with its own paper, like a Word page or a
 * slide — neither the Hippius console nor Google Sheets has a dark
 * spreadsheet, and a dark grid would also fight the cell fills that come out
 * of the file itself (which are authored for a white sheet). So this surface
 * is light in both app themes; the viewer chrome around it still follows the
 * user's theme.
 */
const SHEET_BORDER = "#e0e0e0";
const HEADER_CLASS =
  "border-b border-r border-[#e0e0e0] bg-[#f8f9fa] text-center text-[11px] font-normal text-[#5f6368]";
/** Row/column header for the selected cell, as Sheets highlights it. */
const HEADER_ACTIVE_CLASS = "bg-[#d3e3fd] font-medium text-[#202124]";

interface CellAddress {
  row: number;
  column: number;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

/**
 * The file's own alignment wins; otherwise it follows the value's type the way
 * a spreadsheet does — numbers and dates right, booleans and errors centred,
 * text left. Only the ExcelJS path reports alignment, so the type-based rule
 * is what the SheetJS fallback uses.
 */
function cellAlignment(cell: SpreadsheetCell): "left" | "center" | "right" {
  if (cell.style?.align) return cell.style.align;
  switch (cell.kind) {
    case "number":
    case "date":
      return "right";
    case "bool":
    case "error":
      return "center";
    default:
      return "left";
  }
}

/**
 * Office fonts ship on none of the three platforms by default, so a font named
 * in the file gets a metric-compatible stand-in and text keeps roughly the
 * width Excel laid it out at.
 */
function fontStack(family: string): string {
  const lower = family.toLowerCase();
  const mono = /courier|mono|consolas/.test(lower);
  const serif =
    !mono && !/sans/.test(lower) && /times|georgia|cambria|garamond|serif/.test(lower);
  const substitute =
    lower === "calibri" ? ", Carlito" : lower === "cambria" ? ", Caladea" : "";
  const generic = mono
    ? '"Liberation Mono", "Courier New", monospace'
    : serif
      ? '"Liberation Serif", "Times New Roman", serif'
      : '"Liberation Sans", Arial, Helvetica, sans-serif';
  return `"${family}"${substitute}, ${generic}`;
}

/** Sheets lets text spill over empty neighbours; measure how far it may go. */
function overflowWidth(
  row: SpreadsheetCell[],
  column: number,
  widths: number[],
): number {
  let extra = 0;
  for (let next = column + 1; next < row.length; next += 1) {
    const neighbour = row[next] ?? EMPTY_CELL;
    if (neighbour.kind !== "empty" || neighbour.covered || neighbour.style?.fill) break;
    extra += widths[next] ?? DEFAULT_COLUMN_WIDTH;
  }
  return extra;
}

/** First index whose offset is greater than `value` (binary search). */
function upperBound(offsets: number[], value: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Read-only Google-Sheets-style grid: a formula bar, lettered column headers
 * and numbered rows, gridlines that continue past the data to fill the
 * viewer, click-to-select, frozen panes, merges, and the file's own column
 * widths, row heights and fills.
 *
 * Rows are virtualised, so a sheet renders at its full extent without the DOM
 * growing with it — the gridlines filling empty space are what make it read as
 * a spreadsheet rather than an HTML table, and drawing those unvirtualised
 * would be unbounded.
 */
export default function SpreadsheetGrid({
  sheet,
  className,
}: {
  sheet: SpreadsheetSheet;
  className?: string;
}) {
  const [viewportRef, viewport] = useElementSize<HTMLDivElement>();
  const [selected, setSelected] = useState<CellAddress>({ row: 0, column: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const frameRef = useRef<number | null>(null);

  // Switching sheet (or file) resets the selection and the scroll position, so
  // a new sheet never opens scrolled into the middle of the previous one.
  useEffect(() => {
    setSelected({ row: 0, column: 0 });
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [sheet, viewportRef]);

  // Scroll drives the virtual window, so it is sampled once per frame rather
  // than re-rendering the grid on every scroll event.
  const handleScroll = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setScrollTop(viewportRef.current?.scrollTop ?? 0);
    });
  }, [viewportRef]);

  useEffect(
    () => () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // Columns: the file's visible columns, plus empty ones so the gridlines
  // reach the right edge of the viewer the way Sheets' do.
  const visibleColumns = useMemo(() => {
    const columns: number[] = [];
    for (let index = 0; index < sheet.columnCount; index += 1) {
      if ((sheet.columnWidths[index] ?? DEFAULT_COLUMN_WIDTH) > 0) columns.push(index);
    }
    return columns;
  }, [sheet]);

  const dataWidth = visibleColumns.reduce(
    (sum, column) => sum + (sheet.columnWidths[column] ?? DEFAULT_COLUMN_WIDTH),
    0,
  );
  const fillColumnCount = viewportFillCount(
    viewport.width - ROW_HEADER_WIDTH,
    dataWidth,
    DEFAULT_COLUMN_WIDTH,
  );
  const columnKeys = useMemo(
    () => [
      ...visibleColumns,
      ...Array.from({ length: fillColumnCount }, (_, i) => sheet.columnCount + i),
    ],
    [visibleColumns, fillColumnCount, sheet.columnCount],
  );
  const widths = columnKeys.map(
    (column) => sheet.columnWidths[column] ?? DEFAULT_COLUMN_WIDTH,
  );
  const tableWidth = ROW_HEADER_WIDTH + widths.reduce((a, b) => a + b, 0);

  // Frozen columns stick at the left edge, after the row-number column.
  const frozenLeft = useMemo(() => {
    const offsets = new Map<number, number>();
    let left = ROW_HEADER_WIDTH;
    for (const column of columnKeys) {
      if (column >= sheet.frozenColumns) break;
      offsets.set(column, left);
      left += sheet.columnWidths[column] ?? DEFAULT_COLUMN_WIDTH;
    }
    return offsets;
  }, [columnKeys, sheet]);

  // Rows: the file's rows plus empty ones to fill the viewer, virtualised.
  const dataHeight = sheet.rowHeights.reduce((sum, height) => sum + height, 0);
  const fillRowCount = viewportFillCount(
    viewport.height - COLUMN_HEADER_HEIGHT,
    dataHeight,
    DEFAULT_ROW_HEIGHT,
  );
  const rowCount = sheet.rows.length + fillRowCount;
  const rowHeight = useCallback(
    (index: number) =>
      index < sheet.rows.length
        ? (sheet.rowHeights[index] ?? DEFAULT_ROW_HEIGHT)
        : DEFAULT_ROW_HEIGHT,
    [sheet],
  );
  const offsets = useMemo(() => {
    const result = new Array<number>(rowCount + 1);
    result[0] = 0;
    for (let index = 0; index < rowCount; index += 1) {
      result[index + 1] = result[index] + rowHeight(index);
    }
    return result;
  }, [rowCount, rowHeight]);
  const totalHeight = offsets[rowCount] ?? 0;

  let startRow = Math.max(0, upperBound(offsets, scrollTop - OVERSCAN_PX) - 1);
  const endRow = Math.min(
    rowCount,
    upperBound(offsets, scrollTop + viewport.height + OVERSCAN_PX),
  );
  // A merged range that starts above the window must still be rendered, or the
  // cells it covers would leave a hole where its anchor should be.
  for (const merge of sheet.merges) {
    if (merge.r0 < startRow && merge.r1 >= startRow) startRow = merge.r0;
  }
  startRow = Math.max(startRow, sheet.frozenRows);

  const frozenTop = useMemo(() => {
    const tops = new Map<number, number>();
    let top = COLUMN_HEADER_HEIGHT;
    for (let index = 0; index < sheet.frozenRows; index += 1) {
      tops.set(index, top);
      top += sheet.rowHeights[index] ?? DEFAULT_ROW_HEIGHT;
    }
    return tops;
  }, [sheet]);

  const selectedCell = sheet.rows[selected.row]?.[selected.column] ?? EMPTY_CELL;

  const renderRow = (rowIndex: number) => {
    const row = sheet.rows[rowIndex];
    const height = rowHeight(rowIndex);
    if (height === 0) return null;
    const stickyTop = frozenTop.get(rowIndex);
    const rowSticky: CSSProperties | undefined =
      stickyTop !== undefined ? { position: "sticky", top: stickyTop } : undefined;

    return (
      <tr key={rowIndex} style={{ height }}>
        <th
          scope="row"
          style={rowSticky}
          className={cn(
            "sticky left-0 z-10",
            HEADER_CLASS,
            stickyTop !== undefined && "z-[25]",
            rowIndex === selected.row && HEADER_ACTIVE_CLASS,
          )}
        >
          {rowIndex + 1}
        </th>
        {columnKeys.map((column, position) => {
          const cell = row?.[column] ?? EMPTY_CELL;
          if (cell.covered) return null;
          const style = cell.style;
          const isSelected = rowIndex === selected.row && column === selected.column;
          const align = cellAlignment(cell);
          const spill =
            cell.kind === "text" && !style?.wrap && !style?.fill && row && align === "left"
              ? overflowWidth(row, column, sheet.columnWidths)
              : 0;
          const stickyLeft = frozenLeft.get(column);
          const inline: CSSProperties = {
            backgroundColor: style?.fill,
            color: style?.color,
            textAlign: align,
            verticalAlign:
              style?.valign === "middle" ? "middle" : (style?.valign ?? "bottom"),
            fontWeight: style?.bold ? 700 : undefined,
            fontStyle: style?.italic ? "italic" : undefined,
            fontFamily: style?.fontFamily ? fontStack(style.fontFamily) : undefined,
            fontSize: style?.fontSize,
            textDecoration:
              style?.underline && style?.strike
                ? "underline line-through"
                : style?.underline
                  ? "underline"
                  : style?.strike
                    ? "line-through"
                    : undefined,
            // Only right/bottom are drawn; the parser folds each neighbour's
            // left/top into them so a box shows all four of its sides.
            borderRight: style?.borderRight
              ? `${style.borderRight.width}px solid ${style.borderRight.color}`
              : undefined,
            borderBottom: style?.borderBottom
              ? `${style.borderBottom.width}px solid ${style.borderBottom.color}`
              : undefined,
          };
          if (stickyLeft !== undefined) {
            inline.position = "sticky";
            inline.left = stickyLeft;
          }
          if (stickyTop !== undefined) {
            inline.position = "sticky";
            inline.top = stickyTop;
          }
          const frozen = stickyLeft !== undefined || stickyTop !== undefined;

          return (
            <td
              key={column}
              colSpan={cell.colSpan}
              rowSpan={cell.rowSpan}
              onClick={() => setSelected({ row: rowIndex, column })}
              style={inline}
              className={cn(
                "border-b border-r border-[#e0e0e0] px-1 leading-[1.35]",
                frozen && !style?.fill ? "bg-white" : "relative",
                stickyLeft !== undefined && stickyTop !== undefined
                  ? "z-20"
                  : frozen
                    ? "z-[15]"
                    : undefined,
                spill > 0 ? "overflow-visible" : "overflow-hidden",
                style?.wrap ? "whitespace-pre-wrap break-words" : "whitespace-nowrap",
                isSelected && "z-[5] shadow-[inset_0_0_0_2px_#1a73e8]",
              )}
            >
              {spill > 0 ? (
                <span
                  className="absolute inset-y-0 left-0 z-[1] flex items-end overflow-hidden whitespace-nowrap bg-white px-1 pb-px"
                  style={{ maxWidth: widths[position] + spill, width: "max-content" }}
                >
                  {cell.text}
                </span>
              ) : (
                cell.text
              )}
            </td>
          );
        })}
      </tr>
    );
  };

  const windowRows: ReactNode[] = [];
  for (let index = 0; index < sheet.frozenRows; index += 1) {
    windowRows.push(renderRow(index));
  }
  for (let index = startRow; index < endRow; index += 1) {
    windowRows.push(renderRow(index));
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col bg-white", className)}>
      {/* Formula bar: the selected cell's address, the fx marker, its value. */}
      <div
        className="flex h-9 shrink-0 items-center text-xs"
        style={{ borderBottom: `1px solid ${SHEET_BORDER}` }}
      >
        <div
          className="flex h-full w-20 shrink-0 items-center justify-center font-medium text-[#202124]"
          style={{ borderRight: `1px solid ${SHEET_BORDER}` }}
        >
          {columnLabel(selected.column)}
          {selected.row + 1}
        </div>
        <div
          className="flex h-full w-10 shrink-0 items-center justify-center font-serif italic text-[#5f6368]"
          style={{ borderRight: `1px solid ${SHEET_BORDER}` }}
        >
          fx
        </div>
        <div
          className="min-w-0 flex-1 truncate px-3 text-[#202124]"
          title={selectedCell.text}
        >
          {selectedCell.text}
        </div>
      </div>

      <div
        ref={viewportRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 select-text overflow-auto"
      >
        <table
          className="border-separate border-spacing-0 text-[13px] text-[#202124] [font-family:Arial,Helvetica,sans-serif]"
          style={{ tableLayout: "fixed", width: tableWidth }}
        >
          <colgroup>
            <col style={{ width: ROW_HEADER_WIDTH }} />
            {columnKeys.map((column, index) => (
              <col key={column} style={{ width: widths[index] }} />
            ))}
          </colgroup>
          <thead>
            <tr style={{ height: COLUMN_HEADER_HEIGHT }}>
              <th className={cn("sticky left-0 top-0 z-30", HEADER_CLASS)} />
              {columnKeys.map((column) => {
                const stickyLeft = frozenLeft.get(column);
                return (
                  <th
                    key={column}
                    scope="col"
                    style={stickyLeft !== undefined ? { left: stickyLeft } : undefined}
                    className={cn(
                      "sticky top-0 z-20",
                      stickyLeft !== undefined && "z-30",
                      HEADER_CLASS,
                      column === selected.column && HEADER_ACTIVE_CLASS,
                    )}
                  >
                    {columnLabel(column)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {/* Spacers stand in for the rows outside the virtual window so the
                scrollbar reflects the sheet's real height. */}
            {startRow > sheet.frozenRows ? (
              <tr style={{ height: offsets[startRow] - offsets[sheet.frozenRows] }}>
                <td colSpan={columnKeys.length + 1} className="border-0 p-0" />
              </tr>
            ) : null}
            {windowRows}
            {endRow < rowCount ? (
              <tr style={{ height: totalHeight - offsets[endRow] }}>
                <td colSpan={columnKeys.length + 1} className="border-0 p-0" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Bottom sheet switcher, mirroring the tab strip in Sheets. */
export function SheetTabs({
  sheets,
  activeIndex,
  onChange,
}: {
  sheets: SpreadsheetSheet[];
  activeIndex: number;
  onChange: (index: number) => void;
}) {
  // A single-sheet workbook (and every CSV) shows no tab strip.
  if (sheets.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="Sheets"
      className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto bg-[#f8f9fa] px-2"
      style={{ borderTop: `1px solid ${SHEET_BORDER}` }}
    >
      {sheets.map((sheet, index) => (
        <button
          key={`${sheet.name}-${index}`}
          type="button"
          role="tab"
          aria-selected={index === activeIndex}
          onClick={() => onChange(index)}
          className={cn(
            "relative shrink-0 px-4 text-xs font-medium transition-colors",
            index === activeIndex
              ? "bg-white text-[#0b57d0] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#0b57d0]"
              : "text-[#5f6368] hover:bg-[#e8eaed] hover:text-[#202124]",
          )}
        >
          {sheet.name}
        </button>
      ))}
    </div>
  );
}
