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
vi.mock("@/components/ui/CustomTooltip2", () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
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

    fireEvent.click(screen.getByTestId("sync-status-toggle"));

    const fileItems = screen.getAllByTestId("file-item");
    expect(fileItems).toHaveLength(3);
  });

  it("shows the failure reason on an error row instead of the byte size", () => {
    const reason = "Insufficient credits — needs $1.00, you have $0.12.";
    const files = [
      makeFileProgress("invoice.pdf", {
        status: "error",
        totalBytes: 2048,
        error: reason,
      }),
    ];
    const snapshot = makeSnapshot(files);

    renderWithJotai(<SyncStatusDialog snapshot={snapshot} open={true} />);

    fireEvent.click(screen.getByTestId("sync-status-toggle"));

    const item = screen.getByTestId("file-item");
    // The Rust-authored reason replaces the size meta; the "Error" pill stays.
    expect(item).toHaveTextContent(reason);
    expect(item).toHaveTextContent("Error");
    // 2048 bytes would render as "2.05 KB" — the reason takes its place.
    expect(item).not.toHaveTextContent("2.05 KB");
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

    expect(screen.getByTestId("overall-progress-label")).toHaveTextContent("60%");
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

    fireEvent.click(screen.getByTestId("sync-status-toggle"));

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
    // Session stays active due to deferred completion; overallPercent = 100.
    // Rust's fixup_stalled_completion detects all files done and overrides
    // effectiveCompleted=true, so the widget shows "Complete" even though
    // isActive is still true.
    const snapshot1 = makeSnapshot(completedFiles, {
      startedAt: sessionTime,
      isActive: true,
      overallPercent: 100,
      effectiveCompleted: true,
      effectiveInProgress: false,
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

    expect(screen.getByText("Complete")).toBeInTheDocument();

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

    expect(screen.getByTestId("overall-progress-label")).toHaveTextContent("80%");
  });

  function compactSummaryTexts(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("span")).map(
      (element) => element.textContent ?? "",
    );
  }

  it("renders 'X of Y' intent line when intentActive is true", () => {
    // Multi-file in-progress snapshot — required for the "Overall progress"
    // section to render (gated by !isSingleFile && effectiveInProgress).
    const files = [
      makeFileProgress("a.bin", {
        status: "inProgress",
        progressPercent: 50,
        bytesTransferred: 2_500_000,
        totalBytes: 5_000_000,
      }),
      makeFileProgress("b.bin", {
        status: "pending",
        totalBytes: 2_500_000,
      }),
    ];
    const snapshot = makeSnapshot(files, {
      intentTotalFiles: 100,
      intentCompletedFiles: 50,
      intentTotalBytes: 10_000_000_000,
      intentCompletedBytes: 5_000_000_000,
      intentActive: true,
    });

    const { container } = renderWithJotai(
      <SyncStatusDialog snapshot={snapshot} open={true} />,
    );

    const summaryTexts = compactSummaryTexts(container);
    expect(summaryTexts).toContain("5GB/10GB");
    expect(summaryTexts).not.toContain("2.5MB/7.5MB");
  });

  it("falls back to per-cycle line when intent fields are undefined", () => {
    // Legacy / pre-login snapshot shape: no intent overlay. The size row
    // must keep showing the per-cycle "progressBytes / bytesExpected".
    const files = [
      makeFileProgress("a.bin", {
        status: "inProgress",
        progressPercent: 50,
        bytesTransferred: 2_500_000,
        totalBytes: 5_000_000,
      }),
      makeFileProgress("b.bin", {
        status: "pending",
        totalBytes: 2_500_000,
      }),
    ];
    const snapshot = makeSnapshot(files);
    // Sanity check: factory did not silently populate intent fields.
    expect(snapshot.intentActive).toBeUndefined();
    expect(snapshot.intentTotalBytes).toBeUndefined();

    const { container } = renderWithJotai(
      <SyncStatusDialog snapshot={snapshot} open={true} />,
    );

    const summaryTexts = compactSummaryTexts(container);
    expect(summaryTexts).toContain("2.5MB/7.5MB");
    expect(summaryTexts).not.toContain("5GB/10GB");
  });

  it("falls back to per-cycle line when intentActive is true but intentTotalBytes is 0", () => {
    // Manifest exists but is empty — the `> 0` guard on intentTotalBytes
    // catches this so we do not render "0 B of 0 B". The `??` operator
    // (not `||`) lets us distinguish absent (undefined) from explicit 0
    // in the type, even though both fail the guard here.
    const files = [
      makeFileProgress("a.bin", {
        status: "inProgress",
        progressPercent: 50,
        bytesTransferred: 2_500_000,
        totalBytes: 5_000_000,
      }),
      makeFileProgress("b.bin", {
        status: "pending",
        totalBytes: 2_500_000,
      }),
    ];
    const snapshot = makeSnapshot(files, {
      intentTotalFiles: 0,
      intentCompletedFiles: 0,
      intentTotalBytes: 0,
      intentCompletedBytes: 0,
      intentActive: true,
    });

    const { container } = renderWithJotai(
      <SyncStatusDialog snapshot={snapshot} open={true} />,
    );

    const summaryTexts = compactSummaryTexts(container);
    expect(summaryTexts).toContain("2.5MB/7.5MB");
    expect(summaryTexts).not.toContain("0B/0B");
  });

  it("renders the compact ring instead of the full card when minimized", () => {
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
      <SyncStatusDialog snapshot={snapshot} open={true} minimized={true} />,
    );

    // Compact ring is shown…
    expect(screen.getByTestId("sync-status-mini")).toBeInTheDocument();
    expect(screen.getByTestId("sync-status-mini-label")).toHaveTextContent("60%");
    // …and the full card's expand toggle / file list are not rendered.
    expect(screen.queryByTestId("sync-status-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("file-item")).not.toBeInTheDocument();
  });

  it("calls onExpand when the minimized ring is clicked", () => {
    const onExpand = vi.fn();
    const files = [
      makeFileProgress("data.csv", {
        status: "inProgress",
        progressPercent: 40,
        bytesTransferred: 400,
        totalBytes: 1000,
      }),
    ];
    const snapshot = makeSnapshot(files);

    renderWithJotai(
      <SyncStatusDialog
        snapshot={snapshot}
        open={true}
        minimized={true}
        onExpand={onExpand}
      />,
    );

    fireEvent.click(screen.getByTestId("sync-status-mini"));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("shows Complete when Rust fixes stalled active session at 100%", () => {
    // Reproduces the bug scenario: hcfs-client leaves is_active=true due to
    // its file watcher detecting self-generated writes (changes_pending stuck).
    // The Rust fixup_stalled_completion() overrides effectiveCompleted=true
    // even though isActive is still true.
    const files = [
      makeFileProgress("a.txt", { status: "completed", progressPercent: 100, bytesTransferred: 1000, totalBytes: 1000 }),
      makeFileProgress("b.txt", { status: "completed", progressPercent: 100, bytesTransferred: 1000, totalBytes: 1000 }),
      makeFileProgress("c.txt", { status: "completed", progressPercent: 100, bytesTransferred: 1000, totalBytes: 1000 }),
    ];
    const snapshot = makeSnapshot(files, {
      isActive: true,
      overallPercent: 100,
      effectiveCompleted: true,
      effectiveInProgress: false,
      widgetState: "completed",
      statusVariant: "success",
    });

    renderWithJotai(
      <SyncStatusDialog snapshot={snapshot} open={true} />,
    );

    expect(screen.getByText("Complete")).toBeInTheDocument();
  });
});
