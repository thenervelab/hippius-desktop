import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { forwardRef, createRef } from "react";

// The toolbar's neighbours read navigation, credits and drive state; they have
// their own tests. Only where Capture sits is under test here.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@/lib/hooks/useFilesNavigation", () => ({ useFilesNavigation: () => ({ navigateToFilesView: vi.fn() }) }));
vi.mock("@/app/lib/hooks/useNavigationLoader", () => ({ default: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/hooks/useCreditCheck", () => ({ useCreditCheck: () => ({ requireUploadRoom: async () => true }) }));
vi.mock("../AddFileButton", () => ({
  default: forwardRef<HTMLButtonElement>(function AddFile(_props, ref) {
    return (
      <button ref={ref} type="button">
        File
      </button>
    );
  }),
}));
vi.mock("../FolderUploadDialog", () => ({ default: () => null }));
vi.mock("../FolderToFolderUploadDialog", () => ({ default: () => null }));
vi.mock("../DriveSharingHeaderMark", () => ({ default: () => null }));
vi.mock("../FolderSharingMark", () => ({ FolderSharingHeaderMark: () => null }));
vi.mock("../storage-stats", () => ({ default: () => null }));
vi.mock("../FilterPills", () => ({ default: () => null }));
vi.mock("../filter-chips", () => ({ default: () => null }));
vi.mock("@/app/components/StartSyncingButton", () => ({ default: () => null }));
vi.mock("@/app/components/capture/CaptureButtons", () => ({
  default: () => (
    <button type="button" data-testid="capture-menu">
      Capture
    </button>
  ),
}));

import DriveHeader from "../DriveHeader";

function renderHeader(isRecentFiles: boolean) {
  return render(
    <DriveHeader
      isRecentFiles={isRecentFiles}
      formattedStorageSize="0 B"
      allFilteredDataLength={0}
      viewMode="list"
      setViewMode={() => undefined}
      searchTerm=""
      handleSearchChange={() => undefined}
      activeFilters={[]}
      handleRemoveFilter={() => undefined}
      refetchUserFiles={() => undefined}
      addButtonRef={createRef()}
      selectedFileSizes={[]}
      onFileExtensionChange={() => undefined}
      onDateRangeChange={() => undefined}
      onFileSizesChange={() => undefined}
    />,
  );
}

/** Where `name` sits among the toolbar's buttons, left to right. */
function order(): string[] {
  return screen.getAllByRole("button").map((b) => b.textContent?.trim() ?? "");
}

describe("Capture on Overview", () => {
  // Overview's Recent Files toolbar offers Capture beside Folder and File,
  // exactly where a drive's own toolbar has it.
  it("sits in the Recent Files toolbar, just before Folder and File", () => {
    renderHeader(true);
    expect(screen.getByRole("heading", { name: "Recent Files" })).toBeInTheDocument();
    const buttons = order();
    const capture = buttons.indexOf("Capture");
    expect(capture).toBeGreaterThan(-1);
    expect(buttons.indexOf("View All Files")).toBeLessThan(capture);
    expect(buttons.indexOf("Folder")).toBe(capture + 1);
    expect(buttons.indexOf("File")).toBeGreaterThan(capture);
    expect(screen.getAllByTestId("capture-menu")).toHaveLength(1);
  });

  it("sits in the same place in a drive's toolbar", () => {
    renderHeader(false);
    const buttons = order();
    const capture = buttons.indexOf("Capture");
    expect(buttons.indexOf("Folder")).toBe(capture + 1);
    expect(screen.getAllByTestId("capture-menu")).toHaveLength(1);
  });

  // The toolbar wraps rather than overflow at phone widths (320 to 430).
  it("wraps with the rest of the toolbar at narrow widths", () => {
    renderHeader(true);
    const group = screen.getByTestId("capture-menu").parentElement as HTMLElement;
    expect(group).toHaveClass("flex-wrap");
    expect(within(group).getByRole("button", { name: "File" })).toBeInTheDocument();
  });
});
