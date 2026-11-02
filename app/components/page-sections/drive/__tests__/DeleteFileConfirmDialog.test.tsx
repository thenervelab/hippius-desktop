import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// The delete itself is `useDeleteFile`'s, pinned by its own tests.
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  // A capture's links, as its Insights find them: by file name here.
  links: {} as Record<string, string[]>,
}));
vi.mock("@/app/lib/hooks/use-delete-file", () => ({
  default: () => ({ mutate: h.mutate, isPending: false }),
  useDeleteFile: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock("../useCaptureInsightsItem", () => ({
  useCaptureLinkTokens: () => (file: FormattedUserFile) => h.links[file.name] ?? [],
}));

import DeleteFileConfirmDialog from "../DeleteFileConfirmDialog";

const REPORT = { name: "report.pdf" } as FormattedUserFile;
const SHOT = { name: "Screenshot 2026-10-30 at 10.00.00.png", label: "Hippius Captures" } as FormattedUserFile;

beforeEach(() => {
  h.mutate.mockReset();
  h.links = { [SHOT.name]: ["tok-1"] };
});

describe("DeleteFileConfirmDialog", () => {
  // A file with no links to find: the dialog says links made from it keep working.
  it("says the file's share links keep working, and where to turn them off", () => {
    render(<DeleteFileConfirmDialog file={REPORT} onClose={() => undefined} />);
    expect(screen.getByText("Share links made from it keep working. Turn them off in Shared Links.")).toBeInTheDocument();
    expect(screen.queryByTestId("turn-off-links")).toBeNull();
  });

  // The question and the helper line describe the dialog, not its buttons.
  it("is described by its question and the share links line", () => {
    render(<DeleteFileConfirmDialog file={REPORT} onClose={() => undefined} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      'Are you sure you want to delete "report.pdf"? This action cannot be undone. Share links made from it keep working. Turn them off in Shared Links.',
    );
  });

  it("offers to turn off a capture's links, ticked, and passes them to the delete", () => {
    render(<DeleteFileConfirmDialog file={SHOT} onClose={() => undefined} />);
    const box = screen.getByRole("checkbox", { name: "Also turn off its links" });
    expect(box).toBeChecked();
    expect(screen.queryByText(/keep working\. Turn them off in Shared Links/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete File" }));
    const [options] = h.mutate.mock.calls[0];
    expect(options.turnOffLinks.get(SHOT)).toEqual(["tok-1"]);
  });

  it("keeps the links when the box is unticked", () => {
    render(<DeleteFileConfirmDialog file={SHOT} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Also turn off its links" }));
    expect(screen.getByText("The links keep working. You can turn them off in Shared Links.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete File" }));
    expect(h.mutate.mock.calls[0][0].turnOffLinks).toBeUndefined();
  });
});
