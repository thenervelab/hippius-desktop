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

vi.mock("@/components/ui/MiddleTruncatedName", () => ({
  default: ({ name, className, suffix }: { name: string; className?: string; suffix?: React.ReactNode }) => (
    <span data-testid="middle-truncated-name" className={className} title={name}>{name}{suffix}</span>
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

    // In collapsed state, the header shows "Syncing 60%" as status text.
    const statusText = screen.getByText("Syncing 60%");
    expect(statusText).toBeInTheDocument();
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

  it("adjusts percentage down when new files are added mid-session", () => {
    // Simulate deferred completion: first 4 files complete (100%),
    // then a 5th file is merged into the same session (87%).
    // With deferred completion the session stays active.
    const completedFiles = [
      makeFileProgress("a.txt", { status: "completed", progressPercent: 100, bytesTransferred: 1000, totalBytes: 1000 }),
      makeFileProgress("b.txt", { status: "completed", progressPercent: 100, bytesTransferred: 1000, totalBytes: 1000 }),
      makeFileProgress("c.txt", { status: "completed", progressPercent: 100, bytesTransferred: 1000, totalBytes: 1000 }),
      makeFileProgress("d.txt", { status: "completed", progressPercent: 100, bytesTransferred: 1000, totalBytes: 1000 }),
    ];
    const sessionTime = Date.now();
    // Session stays active due to deferred completion; overallPercent = 100
    const snapshot1 = makeSnapshot(completedFiles, {
      startedAt: sessionTime,
      isActive: true,
      overallPercent: 100,
    });

    const store = createStore();
    store.set(syncEngineHealthAtom, {
      status: "connected",
      last_check_time: Date.now(),
      last_successful_check: Date.now(),
      consecutive_failures: 0,
      server_version: null,
      error_message: null,
    });

    const { rerender } = render(
      <Provider store={store}>
        <SyncStatusDialog snapshot={snapshot1} open={true} />
      </Provider>,
    );

    // Should show "Syncing..." for 100% (status text shows "Syncing..." when at 100%)
    expect(screen.getByText("Syncing...")).toBeInTheDocument();

    // Now add a 5th file (deferred completion merged it in)
    const mergedFiles = [
      ...completedFiles,
      makeFileProgress("e.txt", { status: "decrypting", progressPercent: 0, bytesTransferred: 0, totalBytes: 1000 }),
    ];
    // overallPercent = 4000/5000 = 80%
    const snapshot2 = makeSnapshot(mergedFiles, { startedAt: sessionTime });

    rerender(
      <Provider store={store}>
        <SyncStatusDialog snapshot={snapshot2} open={true} />
      </Provider>,
    );

    // After new file added, percentage should adjust to ~80% (4000/5000),
    // NOT stay locked at 100%.
    const percentText = screen.getByText("Syncing 80%");
    expect(percentText).toBeInTheDocument();
  });
});
