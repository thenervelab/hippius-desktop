import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

// The one "Upload File" dialog: the Drive and Recent Files Upload buttons
// and the tray's Upload tile all open it.

vi.mock("../upload-files-flow", () => ({
  default: (props: { mode?: string; initialPaths?: string[] | null; folderName?: string; defaultFolderLabel?: string | null }) => (
    <div data-testid="upload-flow" data-mode={props.mode ?? "root"} data-folder={props.folderName ?? ""} data-label={props.defaultFolderLabel ?? ""}>
      {(props.initialPaths ?? []).join(",")}
    </div>
  ),
}));

import UploadFileDialog from "../UploadFileDialog";

describe("UploadFileDialog", () => {
  it("is titled Upload File, says the upload is private, and uploads to a drive's root", () => {
    render(<UploadFileDialog open onClose={() => {}} initialPaths={["/Users/me/a.png"]} defaultFolderLabel="Docs" />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Upload File").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Private")).toBeInTheDocument();
    const flow = within(dialog).getByTestId("upload-flow");
    expect(flow).toHaveAttribute("data-mode", "root");
    expect(flow).toHaveAttribute("data-label", "Docs");
    expect(flow).toHaveTextContent("/Users/me/a.png");
  });

  it("uploads into the open folder when given one", () => {
    render(<UploadFileDialog open onClose={() => {}} nestedUpload={{ folderName: "Photos", subfolder: "Photos" }} />);
    const flow = screen.getByTestId("upload-flow");
    expect(flow).toHaveAttribute("data-mode", "folder");
    expect(flow).toHaveAttribute("data-folder", "Photos");
  });

  it("shows nothing while closed", () => {
    render(<UploadFileDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
