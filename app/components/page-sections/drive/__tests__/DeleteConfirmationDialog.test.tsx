import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const h = vi.hoisted(() => ({
  selected: [] as FormattedUserFile[],
  links: {} as Record<string, string[]>,
}));
vi.mock("@/app/contexts/FileSelectionContext", () => ({
  useFileSelection: () => ({ selectedFiles: h.selected, clearSelection: vi.fn() }),
}));
// A capture's links, as its Insights find them: by file name here.
vi.mock("../useCaptureInsightsItem", () => ({
  useCaptureLinkTokens: () => (file: FormattedUserFile) => h.links[file.name] ?? [],
}));

import DeleteConfirmationDialog from "../DeleteConfirmationDialog";

const SHOT = { name: "Screenshot 2026-10-30 at 10.00.00.png" } as FormattedUserFile;
const REC = { name: "Recording 2026-10-30 at 10.05.00.mp4" } as FormattedUserFile;
const NOTES = { name: "notes.txt" } as FormattedUserFile;

beforeEach(() => {
  h.links = { [SHOT.name]: ["tok-1", "tok-2"], [REC.name]: ["tok-2"] };
});

function open(onConfirm = vi.fn()) {
  render(<DeleteConfirmationDialog open onOpenChange={() => undefined} onConfirm={onConfirm} />);
  return onConfirm;
}

describe("DeleteConfirmationDialog: Also turn off their links", () => {
  it("is ticked by default and hands each file's links to the delete", () => {
    h.selected = [SHOT, NOTES, REC];
    const onConfirm = open();
    const box = screen.getByRole("checkbox", { name: "Also turn off their links" });
    expect(box).toBeChecked();
    // Two links in all (one is shared by both captures' lookups).
    expect(screen.getByText("Anyone with one of the 2 links won't be able to open it any more.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete Files" }));
    expect(onConfirm).toHaveBeenCalledWith([SHOT, NOTES, REC], [["tok-1", "tok-2"], [], ["tok-2"]]);
  });

  it("passes no links when unticked", () => {
    h.selected = [SHOT];
    const onConfirm = open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Also turn off its links" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete File" }));
    expect(onConfirm).toHaveBeenCalledWith([SHOT], undefined);
  });

  it("is hidden when nothing selected has a link, and the note stays", () => {
    h.selected = [NOTES];
    open();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Share links made from it keep working. Turn them off in Shared Links.")).toBeInTheDocument();
  });
});
