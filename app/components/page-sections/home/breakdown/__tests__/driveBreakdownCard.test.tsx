// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const hooks = vi.hoisted(() => ({
  useFileTypeSummary: vi.fn(),
  useSourceSummary: vi.fn(),
}));
vi.mock("@/app/lib/hooks/api/useDriveSummaries", () => hooks);

import DriveBreakdownCard from "../DriveBreakdownCard";

const settled = <T,>(data: T) => ({ data, isLoading: false, isError: false });

beforeEach(() => {
  cleanup();
  hooks.useFileTypeSummary.mockReturnValue(
    settled({ images: 25121, videos: 2357, docs: 1333, others: 425667, total: 454478 }),
  );
  hooks.useSourceSummary.mockReturnValue(
    settled({ desktop: 443175, console: 63, mobile: 2188, other: 9052, total: 454478 }),
  );
});

describe("the Drive breakdown card", () => {
  // File types answers the commoner question, so it leads.
  it("opens on file types", () => {
    render(<DriveBreakdownCard />);
    expect(screen.getByText("Drive file types")).toBeInTheDocument();
    expect(screen.getByText("Images")).toBeInTheDocument();
    expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
  });

  // Queried by text, not by role: the shared `TabItem` renders a clickable
  // `<div>` with no button role. That is an accessibility gap in the shared
  // primitive, not something this card can fix locally.
  it("offers both views as tabs", () => {
    render(<DriveBreakdownCard />);
    expect(screen.getByText("File types")).toBeInTheDocument();
    expect(screen.getByText("Upload sources")).toBeInTheDocument();
  });

  it("swaps the title, the icon's data and the legend together", () => {
    render(<DriveBreakdownCard />);
    fireEvent.click(screen.getByText("Upload sources"));

    expect(screen.getByText("Drive upload sources")).toBeInTheDocument();
    expect(screen.getByText("Desktop")).toBeInTheDocument();
    expect(screen.getByText("443,175")).toBeInTheDocument();
    // The other view's buckets go with it; a stale legend under a new title
    // is the failure this guards.
    expect(screen.queryByText("Images")).not.toBeInTheDocument();
  });

  it("goes back", () => {
    render(<DriveBreakdownCard />);
    fireEvent.click(screen.getByText("Upload sources"));
    fireEvent.click(screen.getByText("File types"));
    expect(screen.getByText("Drive file types")).toBeInTheDocument();
    expect(screen.getByText("Images")).toBeInTheDocument();
  });

  // Both halves are fetched up front, so switching never waits on a request.
  it("reads both summaries regardless of which tab is showing", () => {
    render(<DriveBreakdownCard />);
    expect(hooks.useFileTypeSummary).toHaveBeenCalled();
    expect(hooks.useSourceSummary).toHaveBeenCalled();
  });

  // The visible tab's own state drives the card: a failure on the hidden
  // half must not blank the one being looked at.
  it("shows the state of the tab on screen, not the other one", () => {
    hooks.useSourceSummary.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<DriveBreakdownCard />);
    expect(screen.getByText("Images")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Upload sources"));
    expect(screen.getByText(/Couldn't load this breakdown/)).toBeInTheDocument();
  });
});

// "(before tracking)" is true of an upload SOURCE and not of a file TYPE.
// A file's type is read from the file and has always been known; "Others"
// there is audio, archives, code and the server's catch-all. Carrying the
// caveat across made the card explain a limitation it does not have.
describe("the before-tracking caveat", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../DriveBreakdownCard.tsx"),
    "utf8",
  );

  it("is not attached to any file-type slice", () => {
    const types = source.slice(
      source.indexOf("typeSlices"),
      source.indexOf("sourceSlices"),
    );
    expect(types).not.toMatch(/note:\s*["'`]\(before tracking\)/);
  });

  it("stays on the upload-source slice, where it is true", () => {
    const sources = source.slice(source.indexOf("sourceSlices"));
    expect(sources).toMatch(/note:\s*["'`]\(before tracking\)/);
  });
});
