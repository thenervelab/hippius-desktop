// The scope line under a folder row's name on the shares page. An uploaded
// copy must say so, and say -- to the mouse and to a screen reader alike --
// that it is a snapshot; a drive row's line is its path and nothing more.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import FolderShareScope from "@/app/(pages)/shares/FolderShareScope";

describe("FolderShareScope", () => {
  it("labels an uploaded copy and explains it on hover and to screen readers", () => {
    render(<FolderShareScope row={{ source: "uploadedCopy", folderHash: "", pathPrefix: "" }} />);

    const line = screen.getByText("Uploaded copy");
    expect(line).toHaveAttribute(
      "title",
      expect.stringMatching(/later changes to the folder are not included/i),
    );
    expect(line).toHaveTextContent(/Uploaded copy: .*later changes to the folder/i);
    expect(screen.queryByText(/whole drive/i)).not.toBeInTheDocument();
  });

  it("shows a drive row's path once, with no hidden extra text", () => {
    render(
      <FolderShareScope
        row={{ source: "drive", folderHash: "37a8eec1ce19687d", pathPrefix: "Trips/Photos" }}
      />,
    );

    const line = screen.getByText("Trips/Photos");
    expect(line).toHaveAttribute("title", "Trips/Photos");
    expect(line).toHaveTextContent(/^Trips\/Photos$/);
  });
});
