"use client";

import { useEffect, useMemo, useState } from "react";

import { previewByteCap } from "@/app/lib/utils/filePreviewType";
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  parseSpreadsheetPreview,
  type SpreadsheetPreviewData,
  type SpreadsheetSheet,
} from "@/app/lib/utils/preview/spreadsheetPreview";

import { PreviewEmpty, PreviewError, PreviewLoading } from "./PreviewState";
import { PreviewCard, PreviewPane } from "./PreviewSurface";
import SpreadsheetGrid, { SheetTabs } from "./SpreadsheetGrid";
import { usePreviewResource, type PreviewParser } from "./usePreviewResource";

function hasContent(sheet: SpreadsheetSheet): boolean {
  return sheet.rows.some((row) => row.some((cell) => cell.kind !== "empty"));
}

/** XLSX and CSV rendered as a spreadsheet grid with the workbook's sheet tabs. */
export default function SpreadsheetPreview({
  localPath,
  filename,
}: {
  localPath: string;
  filename: string;
}) {
  // Memoised on `filename` only: a new identity here would re-read the file,
  // and the parser needs the name solely to choose the CSV vs binary reader.
  const parser = useMemo<PreviewParser<SpreadsheetPreviewData>>(
    () => (bytes, signal) => parseSpreadsheetPreview(bytes, signal, filename),
    [filename],
  );
  const state = usePreviewResource(localPath, previewByteCap("spreadsheet"), parser);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);

  // Stepping to the next file must not land on sheet 4 of a two-sheet book.
  useEffect(() => {
    setActiveSheetIndex(0);
  }, [localPath]);

  if (state.status === "loading") {
    return <PreviewLoading title="Opening spreadsheet…" />;
  }
  if (state.status === "error") {
    return (
      <PreviewError
        title="Couldn't preview this spreadsheet"
        description={state.message}
      />
    );
  }

  const { sheets } = state.data;
  const activeSheet = sheets[activeSheetIndex] ?? sheets[0];
  if (!activeSheet || !sheets.some(hasContent)) {
    return <PreviewEmpty title="This spreadsheet is empty" />;
  }

  return (
    <PreviewPane>
      {/* The sheet is a document with its own paper, like a Word page or a
          slide: it stays light in both app themes, because neither the console
          nor Google Sheets has a dark spreadsheet and the fills that come out
          of the file are authored for a white sheet. `dark:` overrides on the
          card are what keep it white when the app is dark. */}
      <PreviewCard className="border-[#e0e0e0] bg-white dark:border-[#e0e0e0] dark:bg-white">
        <SpreadsheetGrid key={activeSheet.name} sheet={activeSheet} />
        <SheetTabs
          sheets={sheets}
          activeIndex={activeSheetIndex}
          onChange={setActiveSheetIndex}
        />
      </PreviewCard>
      {activeSheet.truncated ? (
        <p className="shrink-0 pt-2 text-center text-xs text-grey-50 dark:text-grey-light-300">
          This sheet is very large — showing the first{" "}
          {MAX_TABLE_ROWS.toLocaleString()} rows and {MAX_TABLE_COLUMNS} columns.
        </p>
      ) : null}
    </PreviewPane>
  );
}
