import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

import FilesNoEntriesFound from "../files-table/FilesNoEntriesFound";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("FilesNoEntriesFound", () => {
  // Remote folders are read-only from the desktop: uploads into them are
  // not supported yet, so the empty state must not offer an upload CTA or
  // claim the storage is empty (only this folder is).
  it("renders a plain folder-empty notice with no upload CTA in remote views", () => {
    render(<FilesNoEntriesFound isRemoteView />);

    expect(screen.getByText("This Folder Is Empty")).toBeInTheDocument();
    expect(screen.queryByText("Upload a File")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No Entries in Your Storage"),
    ).not.toBeInTheDocument();
  });

  it("keeps the upload CTA for local views", () => {
    render(<FilesNoEntriesFound />);

    expect(screen.getByText("No Entries in Your Storage")).toBeInTheDocument();
    expect(screen.getByText("Upload a File")).toBeInTheDocument();
  });
});
