import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Pins the dispatcher: one entry point picks the renderer for every
 * previewable type. Before this, each call site kept its own
 * `type === "video" | "image" | "PDF"` ladder, so a new format opened in some
 * surfaces and silently did nothing in others.
 *
 * The renderer bodies are stubbed — this asserts *which* one is chosen and how
 * the fallbacks behave, not how each format paints.
 */
const resolved = vi.hoisted(() => ({
  value: { url: "", localPath: "/drive/file", isLoading: false, error: null as string | null },
}));

vi.mock("@/app/lib/hooks/useViewableFileUrl", () => ({
  useViewableFileUrl: () => resolved.value,
  default: () => resolved.value,
}));

// `vi.mock` factories are hoisted above every top-level binding, so each
// stub is written out rather than built by a shared helper.
vi.mock("../ImagePreviewBody", () => ({ default: () => <div data-testid="image-body" /> }));
vi.mock("../VideoPreviewBody", () => ({ default: () => <div data-testid="video-body" /> }));
vi.mock("../PdfPreviewBody", () => ({ default: () => <div data-testid="pdf-body" /> }));
vi.mock("../DocumentPreview", () => ({ default: () => <div data-testid="document-body" /> }));
vi.mock("../SpreadsheetPreview", () => ({ default: () => <div data-testid="spreadsheet-body" /> }));
vi.mock("../PresentationPreview", () => ({ default: () => <div data-testid="presentation-body" /> }));
vi.mock("../JsonPreview", () => ({ default: () => <div data-testid="json-body" /> }));
vi.mock("../PlainTextPreview", () => ({ default: () => <div data-testid="text-body" /> }));
vi.mock("../MarkdownPreview", () => ({ default: () => <div data-testid="markdown-body" /> }));
vi.mock("../HtmlPreview", () => ({ default: () => <div data-testid="html-body" /> }));
vi.mock("../SvgPreview", () => ({ default: () => <div data-testid="svg-body" /> }));

// `PreviewFallback` reads the account from the auth context for its download
// action; the viewer's own toolbar is out of scope here.
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Test" }),
}));

import UnifiedFilePreview from "../UnifiedFilePreview";

function fileNamed(name: string): FormattedUserFile {
  return {
    name,
    actualFileName: name,
    createdAt: 0,
    arionHash: "hash",
    arionCid: "cid",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "req",
    source: `/drive/${name}`,
    label: "drive",
    syncStatus: "synced",
  };
}

const noop = vi.fn();

beforeEach(() => {
  resolved.value = {
    url: "asset://x",
    localPath: "/drive/file",
    isLoading: false,
    error: null,
  };
});

describe("UnifiedFilePreview: one dispatcher, every format", () => {
  it.each([
    ["photo.png", "image-body"],
    ["clip.mp4", "video-body"],
    ["report.pdf", "pdf-body"],
    ["contract.docx", "document-body"],
    ["budget.xlsx", "spreadsheet-body"],
    ["export.csv", "spreadsheet-body"],
    ["deck.pptx", "presentation-body"],
    ["data.json", "json-body"],
    ["notes.txt", "text-body"],
    ["README.md", "markdown-body"],
    ["page.html", "html-body"],
    ["logo.svg", "svg-body"],
  ])("mounts the %s renderer for %s", (filename, testId) => {
    render(
      <UnifiedFilePreview file={fileNamed(filename)} handleFileDownload={noop} />,
    );
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it("picks the renderer from the extension in any casing", () => {
    render(<UnifiedFilePreview file={fileNamed("DECK.PPTX")} handleFileDownload={noop} />);
    expect(screen.getByTestId("presentation-body")).toBeInTheDocument();
  });
});

describe("UnifiedFilePreview: fallbacks", () => {
  it("offers download for a format nothing can render", () => {
    render(<UnifiedFilePreview file={fileNamed("bundle.zip")} handleFileDownload={noop} />);
    expect(screen.getByText("This file can't be previewed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download file/i })).toBeInTheDocument();
  });

  it("explains a legacy Office file instead of showing the generic state", () => {
    // `.doc` is not OOXML — no renderer here opens it — so it must not be
    // mislabelled as supported, and the user is told what to do about it.
    render(<UnifiedFilePreview file={fileNamed("old.doc")} handleFileDownload={noop} />);
    expect(
      screen.getByText("This older Office format can't be previewed"),
    ).toBeInTheDocument();
    expect(screen.getByText(/\.docx, \.xlsx or \.pptx/)).toBeInTheDocument();
  });

  it("surfaces a resolve failure with the download escape hatch", () => {
    resolved.value = {
      url: "",
      localPath: "",
      isLoading: false,
      error: "This file can't be previewed.",
    };
    render(<UnifiedFilePreview file={fileNamed("contract.docx")} handleFileDownload={noop} />);
    expect(screen.getByText("This file couldn't be opened")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download file/i })).toBeInTheDocument();
  });

  it("waits on the cloud decrypt instead of rendering an empty document", () => {
    // A cloud-only file has no local path until `cache_remote_file` finishes.
    resolved.value = { url: "", localPath: "", isLoading: true, error: null };
    render(<UnifiedFilePreview file={fileNamed("contract.docx")} handleFileDownload={noop} />);
    expect(screen.getByText("Decrypting file…")).toBeInTheDocument();
    expect(screen.queryByTestId("document-body")).not.toBeInTheDocument();
  });

  it("does not make media wait on a local path", () => {
    // Image/video/PDF resolve their own URL internally, so an unresolved path
    // must not gate them — that would regress the existing media behaviour.
    resolved.value = { url: "", localPath: "", isLoading: true, error: null };
    render(<UnifiedFilePreview file={fileNamed("photo.png")} handleFileDownload={noop} />);
    expect(screen.getByTestId("image-body")).toBeInTheDocument();
  });
});
