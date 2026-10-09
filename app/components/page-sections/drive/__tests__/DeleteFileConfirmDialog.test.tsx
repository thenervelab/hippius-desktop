import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// The delete itself is `useDeleteFile`'s, pinned by its own tests.
vi.mock("@/app/lib/hooks/use-delete-file", () => ({
  default: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteFile: () => ({ mutate: vi.fn(), isPending: false }),
}));

import DeleteFileConfirmDialog from "../DeleteFileConfirmDialog";

describe("DeleteFileConfirmDialog", () => {
  // Deleting a file does not end its share links yet; the dialog says so.
  it("says the file's share links keep working, and where to turn them off", () => {
    render(<DeleteFileConfirmDialog file={{ name: "report.pdf" } as FormattedUserFile} onClose={() => undefined} />);
    expect(screen.getByText("Share links made from it keep working. Turn them off in Shared Links.")).toBeInTheDocument();
  });

  // The question and the helper line describe the dialog, not its buttons.
  it("is described by its question and the share links line", () => {
    render(<DeleteFileConfirmDialog file={{ name: "report.pdf" } as FormattedUserFile} onClose={() => undefined} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      'Are you sure you want to delete "report.pdf"? This action cannot be undone. Share links made from it keep working. Turn them off in Shared Links.',
    );
  });
});
