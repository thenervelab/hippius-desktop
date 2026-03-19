import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import SyncStatusDialog from "../SyncStatusDialog";
import {
  makeFileProgress,
  makeSnapshot,
} from "@/lib/test-utils/syncSnapshotFactory";
import { EMPTY_SNAPSHOT } from "@/lib/types/syncSnapshot";
import { syncEngineHealthAtom } from "@/lib/store/syncAtoms";

// Mock Tauri APIs (not available in test environment)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock heavy UI components that have complex dependencies
vi.mock("@/components/ui", () => ({
  Graphsheet: ({ className }: { className?: string }) => (
    <div data-testid="graphsheet" className={className} />
  ),
}));
vi.mock("@/components/ui/abstract-icon-wrapper", () => ({
  default: ({ children, className }: {
    children?: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="icon-wrapper" className={className}>
      {children}
    </div>
  ),
}));
vi.mock("@/components/ui/icons", () => ({
  Close: ({ className }: { className?: string }) => (
    <span data-testid="icon-close" className={className} />
  ),
  TickCircle: ({ className }: { className?: string }) => (
    <span data-testid="icon-tick" className={className} />
  ),
  Refresh: ({ className }: { className?: string }) => (
    <span data-testid="icon-refresh" className={className} />
  ),
  InfoCircle: ({ className }: { className?: string }) => (
    <span data-testid="icon-info" className={className} />
  ),
}));
vi.mock("@/components/ui/info-tooltip", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <span data-testid="info-tooltip">{children}</span>
  ),
}));

// Mock fileTypeUtils to avoid deep icon imports
const StubIcon = ({ className }: { className?: string }) => (
  <span data-testid="file-icon" className={className} />
);
vi.mock("../../lib/utils/fileTypeUtils", () => ({
  getFileIcon: () => ({ icon: StubIcon, color: "text-grey-50" }),
  DEFAULT_FILE_FORMAT: "document",
  DIRECTORY_SUFFIX: ".ec_metadata",
  isDirectory: () => false,
  formatDisplayName: (name: string) => name,
}));

function renderWithJotai(
  ui: React.ReactElement,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Jotai atoms are generic, type erasure needed for test helper
  atomValues?: Array<[any, any]>,
) {
  const store = createStore();
  store.set(syncEngineHealthAtom, {
    status: "connected",
    last_check_time: Date.now(),
    last_successful_check: Date.now(),
    consecutive_failures: 0,
    server_version: null,
    error_message: null,
  });
  if (atomValues) {
    for (const [atom, value] of atomValues) {
      store.set(atom, value);
    }
  }
  return render(<Provider store={store}>{ui}</Provider>);
}

describe("SyncStatusDialog", () => {
  it("renders nothing when snapshot is empty and not active", () => {
    const { container } = renderWithJotai(
      <SyncStatusDialog
        snapshot={EMPTY_SNAPSHOT}
        open={true}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders file items when expanded", () => {
    const files = [
      makeFileProgress("report.pdf", {
        status: "inProgress",
        progressPercent: 45,
        bytesTransferred: 450,
        totalBytes: 1000,
      }),
      makeFileProgress("photo.jpg", {
        status: "pending",
        totalBytes: 2000,
      }),
      makeFileProgress("notes.txt", {
        status: "completed",
        progressPercent: 100,
        bytesTransferred: 500,
        totalBytes: 500,
      }),
    ];
    const snapshot = makeSnapshot(files);

    renderWithJotai(
      <SyncStatusDialog snapshot={snapshot} open={true} />,
    );

    // Before expanding, file items exist in DOM but are hidden
    // via max-height: 0px on the body container.
    // Click the header to expand.
    const chevrons = document.querySelectorAll("svg");
    const header = chevrons[1]?.closest("[class*='cursor-pointer']");
    expect(header).toBeTruthy();
    fireEvent.click(header!);

    const fileItems = screen.getAllByTestId("file-item");
    expect(fileItems).toHaveLength(3);
  });

  it("shows percentage in collapsed state", () => {
    const files = [
      makeFileProgress("data.csv", {
        status: "inProgress",
        progressPercent: 60,
        bytesTransferred: 600,
        totalBytes: 1000,
      }),
    ];
    const snapshot = makeSnapshot(files);

    renderWithJotai(
      <SyncStatusDialog snapshot={snapshot} open={true} />,
    );

    // In collapsed state, the header shows the percentage as status text.
    // The percentage also appears in the overall progress bar and per-file
    // bar, so use getAllByText and verify the header one specifically.
    const percentElements = screen.getAllByText("60%");
    expect(percentElements.length).toBeGreaterThanOrEqual(1);
    const headerPercent = percentElements.find(
      (el) => el.classList.contains("text-sm"),
    );
    expect(headerPercent).toBeInTheDocument();
  });

  it("preserves file order from snapshot", () => {
    const files = [
      makeFileProgress("alpha.txt", {
        status: "inProgress",
        progressPercent: 10,
        bytesTransferred: 100,
        totalBytes: 1000,
      }),
      makeFileProgress("beta.txt", {
        status: "pending",
        totalBytes: 500,
      }),
      makeFileProgress("gamma.txt", {
        status: "completed",
        progressPercent: 100,
        bytesTransferred: 200,
        totalBytes: 200,
      }),
    ];
    const snapshot = makeSnapshot(files);

    renderWithJotai(
      <SyncStatusDialog snapshot={snapshot} open={true} />,
    );

    // Expand to see file list
    const header = document.querySelector(
      "[class*='cursor-pointer']",
    );
    fireEvent.click(header!);

    const fileItems = screen.getAllByTestId("file-item");
    expect(fileItems[0]).toHaveTextContent("alpha.txt");
    expect(fileItems[1]).toHaveTextContent("beta.txt");
    expect(fileItems[2]).toHaveTextContent("gamma.txt");
  });
});
