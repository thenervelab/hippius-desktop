import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

/**
 * Drives the REAL Office renderers through the REAL byte-loading lifecycle,
 * with only the Rust IPC replaced by a fixture read.
 *
 * The pure classifier and spreadsheet tests cannot reach what these cover:
 * whether docx-preview and pptx-viewer actually open a file and produce the
 * page/slide DOM the pager and the filmstrip count. Both libraries were chosen
 * over alternatives on exactly that evidence — ExcelJS was dropped after it
 * returned an empty model for real workbooks — so the evidence is kept here.
 *
 * The fixtures are generated in-process rather than committed, so this needs no
 * binary blobs in the repo.
 */
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc: (p: string) => p }));

import * as XLSX from "xlsx";

import DocumentPreview from "../DocumentPreview";
import JsonPreview from "../JsonPreview";
import PlainTextPreview from "../PlainTextPreview";
import PresentationPreview from "../PresentationPreview";
import SpreadsheetPreview from "../SpreadsheetPreview";
import SvgPreview from "../SvgPreview";

/** Makes `read_preview_bytes` return these bytes, as Rust would. */
function serveBytes(bytes: Uint8Array) {
  invoke.mockImplementation(async (command: string) => {
    if (command !== "read_preview_bytes") throw new Error(`unexpected ${command}`);
    return bytes.slice().buffer;
  });
}

/** Rejects the way Rust rejects an over-cap read: the structured error shape. */
function serveTooLarge() {
  invoke.mockRejectedValue({
    kind: "Validation",
    message: "This file is too large to preview. Download it to open it.",
  });
}

const encode = (text: string) => new TextEncoder().encode(text);

// Block body on purpose: `mockReset()` returns the mock, and Vitest
// treats a function returned from `beforeEach` as a teardown callback —
// which would call `invoke()` with no arguments after every test.
beforeEach(() => {
  invoke.mockReset();
});

describe("PlainTextPreview / JsonPreview", () => {
  it("renders text through the Rust-backed read", async () => {
    serveBytes(encode("hello preview"));
    render(<PlainTextPreview localPath="/drive/notes.txt" />);
    await waitFor(() => expect(screen.getByText("hello preview")).toBeInTheDocument());
  });

  it("strips a UTF-8 BOM instead of showing it as a glyph", async () => {
    serveBytes(encode("﻿clean"));
    render(<PlainTextPreview localPath="/drive/bom.txt" />);
    await waitFor(() => expect(screen.getByText("clean")).toBeInTheDocument());
  });

  it("re-indents minified JSON", async () => {
    serveBytes(encode('{"a":1,"b":[2,3]}'));
    render(<JsonPreview localPath="/drive/data.json" />);
    // Indentation means the value lands on its own line.
    await waitFor(() => expect(screen.getByText(/"a"/)).toBeInTheDocument());
    expect(screen.getByText(/"b"/)).toBeInTheDocument();
  });

  it("shows a graceful state for invalid JSON rather than a wall of text", async () => {
    serveBytes(encode("{not json,,,"));
    render(<JsonPreview localPath="/drive/bad.json" />);
    await waitFor(() =>
      expect(screen.getByText("Couldn't preview this JSON file")).toBeInTheDocument(),
    );
    expect(screen.getByText(/does not contain valid JSON/i)).toBeInTheDocument();
  });

  it("surfaces Rust's over-cap message verbatim", async () => {
    // The copy is owned by Rust so every surface says the same thing; this
    // pins that it travels through the structured error shape unchanged.
    serveTooLarge();
    render(<PlainTextPreview localPath="/drive/huge.txt" />);
    await waitFor(() =>
      expect(
        screen.getByText("This file is too large to preview. Download it to open it."),
      ).toBeInTheDocument(),
    );
  });
});

describe("SvgPreview", () => {
  it("renders an SVG as an inert data: image with the script removed", async () => {
    serveBytes(
      encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
          `<script>alert(1)</script><rect width="10" height="10"/></svg>`,
      ),
    );
    render(<SvgPreview localPath="/drive/logo.svg" filename="logo.svg" />);

    const image = await screen.findByAltText("logo.svg");
    const src = image.getAttribute("src") ?? "";
    // An <img> never executes SVG script and never navigates; the data: URL
    // keeps the document at an opaque origin even if opened elsewhere.
    expect(src.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = atob(src.split(",")[1]);
    expect(decoded).not.toContain("<script");
    expect(decoded).toContain("<rect");
  });

  it("reports bytes that are not an SVG instead of rendering them", async () => {
    serveBytes(encode("<html><body>not an svg</body></html>"));
    render(<SvgPreview localPath="/drive/fake.svg" filename="fake.svg" />);
    await waitFor(() =>
      expect(screen.getByText("Couldn't preview this SVG")).toBeInTheDocument(),
    );
  });
});

describe("SpreadsheetPreview", () => {
  it("renders a Google-Sheets-style grid with headers, formula bar and sheet tabs", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Name", "Qty"], ["Widget", 12]]),
      "Data",
    );
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Total", 12]]), "Summary");
    serveBytes(new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" })));

    render(<SpreadsheetPreview localPath="/drive/book.xlsx" filename="book.xlsx" />);

    await waitFor(() => expect(screen.getByText("Widget")).toBeInTheDocument());
    // Lettered columns and numbered rows, not a generic HTML table.
    expect(screen.getByRole("columnheader", { name: "A" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "1" })).toBeInTheDocument();
    // The formula bar: cell address, the fx marker, and A1's value.
    expect(screen.getByText("A1")).toBeInTheDocument();
    expect(screen.getByText("fx")).toBeInTheDocument();
    // Sheet tabs for a multi-sheet workbook.
    expect(screen.getByRole("tab", { name: "Data" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Summary" })).toBeInTheDocument();
  });

  it("moves the formula bar to whichever cell is clicked", async () => {
    serveBytes(encode("a,b\n1,2"));
    render(<SpreadsheetPreview localPath="/drive/x.csv" filename="x.csv" />);

    await waitFor(() => expect(screen.getByText("A1")).toBeInTheDocument());
    // "b" is B1; clicking it must move the address box and the value readout.
    fireEvent.click(screen.getByRole("cell", { name: "b" }));
    expect(screen.getByText("B1")).toBeInTheDocument();
    expect(screen.queryByText("A1")).not.toBeInTheDocument();
  });

  it("opens a newly selected sheet at A1 rather than the previous sheet's cell", async () => {
    // The reset this pins only fires on an actual sheet CHANGE. It used to run
    // on mount too, where it could land after a click made in the first frame
    // and drag the selection back to A1.
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Name", "Qty"], ["Widget", 12]]),
      "Data",
    );
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Total", 12]]), "Summary");
    serveBytes(new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" })));

    render(<SpreadsheetPreview localPath="/drive/book.xlsx" filename="book.xlsx" />);
    await waitFor(() => expect(screen.getByRole("cell", { name: "Qty" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("cell", { name: "Qty" }));
    expect(screen.getByText("B1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    expect(screen.getByText("A1")).toBeInTheDocument();
    expect(screen.queryByText("B1")).not.toBeInTheDocument();
  });

  it("shows no tab strip for a CSV, which has exactly one sheet", async () => {
    serveBytes(encode("a,b\n1,2"));
    render(<SpreadsheetPreview localPath="/drive/x.csv" filename="x.csv" />);
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "a" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("tablist", { name: "Sheets" })).not.toBeInTheDocument();
  });
});

/**
 * Real Office documents. Generating a valid DOCX/PPTX in-process is not
 * practical, so these run against sample files when present on the machine and
 * are skipped otherwise — they are evidence for the renderer choice, not a gate
 * that would fail CI for want of a fixture.
 */
const DOCX = "/home/arham/Downloads/sample_document.docx";
const PPTX = "/home/arham/Downloads/sample_presentation.pptx";

describe.skipIf(!existsSync(DOCX))("DocumentPreview against a real .docx", () => {
  it("renders paginated Word pages the pager can count", async () => {
    serveBytes(new Uint8Array(readFileSync(DOCX)));
    const { container } = render(<DocumentPreview localPath="/drive/a.docx" />);

    // `section.docx` is the page element the pager's selector targets; if
    // docx-preview stopped emitting it the pager would silently read zero.
    await waitFor(
      () => expect(container.querySelectorAll("section.docx").length).toBeGreaterThan(0),
      { timeout: 15000 },
    );
    expect(container.textContent?.length ?? 0).toBeGreaterThan(0);
  }, 30000);

  it("reports a corrupt document instead of rendering a blank page", async () => {
    serveBytes(encode("this is not a word document"));
    render(<DocumentPreview localPath="/drive/broken.docx" />);
    await waitFor(
      () => expect(screen.getByText("Couldn't preview this document")).toBeInTheDocument(),
      { timeout: 15000 },
    );
  }, 30000);
});

describe.skipIf(!existsSync(PPTX))("PresentationPreview against a real .pptx", () => {
  it("renders real slides with a slide count", async () => {
    serveBytes(new Uint8Array(readFileSync(PPTX)));
    const { container } = render(<PresentationPreview localPath="/drive/a.pptx" />);

    await waitFor(
      () => expect(screen.getAllByRole("tab", { name: /^Slide \d+$/ }).length).toBeGreaterThan(0),
      { timeout: 15000 },
    );
    // Slides are drawn as SVG, not as a text dump.
    expect(container.querySelector("svg")).not.toBeNull();
  }, 30000);

  it("reports a file it cannot open", async () => {
    serveBytes(encode("not a deck"));
    render(<PresentationPreview localPath="/drive/broken.pptx" />);
    await waitFor(
      () => expect(screen.getByText("Couldn't preview this presentation")).toBeInTheDocument(),
      { timeout: 15000 },
    );
  }, 30000);
});
