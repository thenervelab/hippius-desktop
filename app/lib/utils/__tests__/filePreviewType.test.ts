import { describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_PREVIEW_BYTES,
  MAX_HTML_PREVIEW_BYTES,
  MAX_MARKDOWN_PREVIEW_BYTES,
  MAX_PLAIN_TEXT_PREVIEW_BYTES,
  MAX_PRESENTATION_PREVIEW_BYTES,
  MAX_SPREADSHEET_PREVIEW_BYTES,
  MAX_STREAMED_PREVIEW_BYTES,
  MAX_STRUCTURED_TEXT_PREVIEW_BYTES,
  MAX_SVG_PREVIEW_BYTES,
  RUST_PREVIEW_READ_CEILING_BYTES,
  derivePreviewType,
  isLegacyOfficeFilename,
  isPreviewableFileName,
  isSvgFilename,
  mimeEssence,
  previewByteCap,
  previewExtension,
  previewNeedsBytes,
  type PreviewType,
} from "@/app/lib/utils/filePreviewType";

/**
 * The classifier is the single gate every Drive surface asks "does this row
 * open the viewer, and what renders it?". A wrong answer here is either a dead
 * row or, for the two script-carrying formats, a security failure — so the
 * table below pins every required format rather than spot-checking.
 */
describe("derivePreviewType: every required format", () => {
  const cases: Array<[string, PreviewType]> = [
    ["report.pdf", "PDF"],
    ["index.html", "html"],
    ["index.htm", "html"],
    ["notes.txt", "text"],
    ["README.md", "markdown"],
    ["README.markdown", "markdown"],
    ["contract.docx", "document"],
    ["budget.xlsx", "spreadsheet"],
    ["export.csv", "spreadsheet"],
    ["deck.pptx", "presentation"],
    ["package.json", "json"],
    ["logo.svg", "svg"],
  ];

  it.each(cases)("classifies %s as %s", (filename, expected) => {
    expect(derivePreviewType(filename)).toBe(expected);
    expect(isPreviewableFileName(filename)).toBe(true);
  });

  it("keeps the pre-existing image and video categories", () => {
    // These already opened before the unified viewer; the refactor must not
    // narrow what the media dialogs used to accept.
    for (const name of ["a.jpg", "a.jpeg", "a.png", "a.gif", "a.webp", "a.heic", "a.heif"]) {
      expect(derivePreviewType(name)).toBe("image");
    }
    for (const name of ["a.mp4", "a.mov", "a.webm"]) {
      expect(derivePreviewType(name)).toBe("video");
    }
  });
});

describe("derivePreviewType: casing", () => {
  it.each([
    ["REPORT.PDF", "PDF"],
    ["Notes.TXT", "text"],
    ["Readme.Md", "markdown"],
    ["Contract.DOCX", "document"],
    ["Budget.XlSx", "spreadsheet"],
    ["Deck.PPTX", "presentation"],
    ["Data.JSON", "json"],
    ["Logo.SVG", "svg"],
    ["Page.HTML", "html"],
    ["Photo.JPEG", "image"],
  ] as Array<[string, PreviewType]>)(
    "classifies %s regardless of case",
    (filename, expected) => {
      expect(derivePreviewType(filename)).toBe(expected);
    },
  );

  it("treats an all-caps SVG as an SVG", () => {
    expect(isSvgFilename("LOGO.SVG")).toBe(true);
    expect(isSvgFilename("logo.svg")).toBe(true);
    expect(isSvgFilename("logo.png")).toBe(false);
  });
});

describe("derivePreviewType: names that are not extensions", () => {
  it("does not preview an extensionless file whose NAME matches an extension", () => {
    // "md" and "html" as whole filenames are not Markdown and HTML; without
    // the dot check `getFilePartsFromFileName` reports the whole name as the
    // format and every such file would open a text renderer.
    expect(derivePreviewType("md")).toBeNull();
    expect(derivePreviewType("html")).toBeNull();
    expect(derivePreviewType("json")).toBeNull();
    expect(derivePreviewType("Makefile")).toBeNull();
    expect(previewExtension("Makefile")).toBe("");
  });

  it("does not preview a dotfile with no extension", () => {
    expect(derivePreviewType(".gitignore")).toBeNull();
    expect(derivePreviewType(".env")).toBeNull();
  });

  it("uses only the final extension of a multi-dot name", () => {
    expect(derivePreviewType("archive.tar.gz")).toBeNull();
    expect(derivePreviewType("report.final.docx")).toBe("document");
    expect(derivePreviewType("my.notes.v2.md")).toBe("markdown");
  });

  it("returns null for recognised but unpreviewable extensions", () => {
    for (const name of ["bundle.zip", "script.py", "lib.rs", "db.sqlite", "song.mp3"]) {
      expect(derivePreviewType(name)).toBeNull();
      expect(isPreviewableFileName(name)).toBe(false);
    }
  });
});

describe("derivePreviewType: misleading names and MIME hints", () => {
  it("lets the extension win over a contradicting MIME", () => {
    // A Word file served as text/html must open the Word renderer, never the
    // HTML frame — otherwise a sender chooses the renderer, not the file.
    expect(derivePreviewType("contract.docx", "text/html")).toBe("document");
    expect(derivePreviewType("photo.png", "text/html")).toBe("image");
    expect(derivePreviewType("logo.svg", "image/png")).toBe("svg");
  });

  it("never resolves a known-unpreviewable extension via its MIME", () => {
    // `payload.zip` announced as JSON stays unpreviewable; the extension is
    // the more trustworthy of the two.
    expect(derivePreviewType("payload.zip", "application/json")).toBeNull();
    expect(derivePreviewType("script.py", "text/plain")).toBeNull();
  });

  it("falls back to the MIME hint only for names that say nothing", () => {
    expect(derivePreviewType("blob", "application/pdf")).toBe("PDF");
    expect(derivePreviewType("blob", "text/csv")).toBe("spreadsheet");
    expect(derivePreviewType("blob", "application/json")).toBe("json");
    expect(derivePreviewType("blob", "image/png")).toBe("image");
    expect(
      derivePreviewType(
        "blob",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("document");
    expect(derivePreviewType("blob", "application/octet-stream")).toBeNull();
    expect(derivePreviewType("blob")).toBeNull();
  });

  it("compares the MIME essence, ignoring parameters", () => {
    expect(mimeEssence("text/html; charset=UTF-8")).toBe("text/html");
    expect(derivePreviewType("blob", "text/plain; charset=utf-8")).toBe("text");
  });
});

describe("SVG and HTML safety routing", () => {
  it("routes SVG to its own inert renderer, never to the image path", () => {
    // `image` would hand the file to the plain <img>/HEIC path, which is fine
    // for a raster but skips the sanitiser SVG needs; SVG is a script-capable
    // document and only `SvgPreview` renders it inertly.
    expect(derivePreviewType("logo.svg")).toBe("svg");
    expect(derivePreviewType("logo.svg")).not.toBe("image");
    expect(derivePreviewType("blob", "image/svg+xml")).toBe("svg");
  });

  it("does not treat other +xml image MIMEs as previewable images", () => {
    // No inert renderer exists for them, so they must not fall into <img>.
    expect(derivePreviewType("blob", "image/whatever+xml")).toBeNull();
  });

  it("routes HTML to the isolated frame, including XHTML", () => {
    expect(derivePreviewType("page.html")).toBe("html");
    expect(derivePreviewType("blob", "text/html")).toBe("html");
    expect(derivePreviewType("blob", "application/xhtml+xml")).toBe("html");
  });

  it("reads SVG and HTML from bytes rather than a navigable URL", () => {
    // Both must reach the renderer as bytes: a URL to the file could be
    // navigated, which is exactly what the two formats must never get.
    expect(previewNeedsBytes("svg")).toBe(true);
    expect(previewNeedsBytes("html")).toBe(true);
    // Media keeps streaming from a URL, preserving HEIC/Live Photo/PDF paths.
    expect(previewNeedsBytes("image")).toBe(false);
    expect(previewNeedsBytes("video")).toBe(false);
    expect(previewNeedsBytes("PDF")).toBe(false);
    expect(previewNeedsBytes(null)).toBe(false);
  });
});

describe("legacy Office formats are not mislabelled as supported", () => {
  it.each(["old.doc", "old.xls", "old.ppt", "old.odt", "old.ods", "old.odp", "old.rtf"])(
    "%s is recognised but not previewable",
    (filename) => {
      expect(derivePreviewType(filename)).toBeNull();
      expect(isPreviewableFileName(filename)).toBe(false);
      // Recognised, so the viewer can explain *why* instead of showing the
      // generic unsupported state.
      expect(isLegacyOfficeFilename(filename)).toBe(true);
    },
  );

  it("does not confuse a legacy name with its OOXML successor", () => {
    expect(isLegacyOfficeFilename("new.docx")).toBe(false);
    expect(isLegacyOfficeFilename("new.xlsx")).toBe(false);
    expect(isLegacyOfficeFilename("new.pptx")).toBe(false);
  });
});

describe("per-format byte caps", () => {
  it.each([
    ["markdown", MAX_MARKDOWN_PREVIEW_BYTES],
    ["html", MAX_HTML_PREVIEW_BYTES],
    ["text", MAX_PLAIN_TEXT_PREVIEW_BYTES],
    ["json", MAX_STRUCTURED_TEXT_PREVIEW_BYTES],
    ["svg", MAX_SVG_PREVIEW_BYTES],
    ["spreadsheet", MAX_SPREADSHEET_PREVIEW_BYTES],
    ["document", MAX_DOCUMENT_PREVIEW_BYTES],
    ["presentation", MAX_PRESENTATION_PREVIEW_BYTES],
    ["image", MAX_STREAMED_PREVIEW_BYTES],
    ["video", MAX_STREAMED_PREVIEW_BYTES],
    ["PDF", MAX_STREAMED_PREVIEW_BYTES],
  ] as Array<[PreviewType, number]>)("caps %s at %d bytes", (type, expected) => {
    expect(previewByteCap(type)).toBe(expected);
  });

  it("gives every buffered format a finite, positive cap", () => {
    // An accidental `undefined`/0 would be sent to Rust as the read budget,
    // which is what a cap exists to prevent.
    const types: PreviewType[] = [
      "image", "video", "PDF", "markdown", "html", "text",
      "document", "spreadsheet", "presentation", "json", "svg",
    ];
    for (const type of types) {
      const cap = previewByteCap(type);
      expect(Number.isFinite(cap)).toBe(true);
      expect(cap).toBeGreaterThan(0);
    }
  });

  it("keeps the OOXML caps well below the streamed ceiling", () => {
    // The zip formats inflate on parse, so their ceiling has to be a real
    // limit rather than the nominal media one.
    for (const type of ["document", "spreadsheet", "presentation"] as PreviewType[]) {
      expect(previewByteCap(type)).toBeLessThan(MAX_STREAMED_PREVIEW_BYTES);
    }
  });

  it("does not hold HTML to Markdown's cap", () => {
    // The bug this pins: the two shared one constant, so an ordinary
    // `index.html` a few MB in size refused to open with "too large to
    // preview" while the renderer that would have shown it was never reached.
    // They only look alike — Markdown is walked token-by-token into React
    // elements on the main thread, whereas HTML is parsed natively and handed
    // to a sandboxed frame that parses it natively too.
    expect(previewByteCap("html")).toBeGreaterThan(previewByteCap("markdown"));
    expect(previewByteCap("html")).toBeGreaterThanOrEqual(8 * 1024 * 1024);
  });

  it("ranks the caps by how the renderer actually spends the bytes", () => {
    // Element-per-token renderers (Markdown, JSON) stay tightest; the browser
    // does the work for plain text and HTML, so those sit above them. Keeping
    // this ordering explicit is what stops a format being given a neighbour's
    // cap again just because the two read similarly.
    expect(previewByteCap("markdown")).toBeLessThanOrEqual(previewByteCap("json"));
    expect(previewByteCap("json")).toBeLessThan(previewByteCap("text"));
    expect(previewByteCap("text")).toBeLessThan(previewByteCap("html"));
  });

  it("keeps every buffered cap within the ceiling Rust will actually read", () => {
    // Rust clamps every read to `MAX_PREVIEW_READ_BYTES`, so a per-format cap
    // above it would be unreachable: the file would be refused by Rust and
    // reported as "too large" while sitting inside its own format's cap —
    // the same class of failure as the HTML bug above, one layer down.
    const buffered: PreviewType[] = [
      "markdown", "html", "text", "json", "svg",
      "document", "spreadsheet", "presentation",
    ];
    for (const type of buffered) {
      expect(previewByteCap(type)).toBeLessThanOrEqual(RUST_PREVIEW_READ_CEILING_BYTES);
    }
  });
});
