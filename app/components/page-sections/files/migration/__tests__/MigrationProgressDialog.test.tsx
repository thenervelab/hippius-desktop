import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import MigrationProgressDialog, {
  MigrationFile,
} from "../MigrationProgressDialog";

// Mock Tauri APIs (not available in test environment)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock heavy UI components
vi.mock("@/components/ui", () => ({
  Graphsheet: ({ className }: { className?: string }) => (
    <div data-testid="graphsheet" className={className} />
  ),
  Icons: {
    HippiusLogo: ({ className }: { className?: string }) => (
      <span data-testid="icon-logo" className={className} />
    ),
    Loader: ({ className }: { className?: string }) => (
      <span data-testid="icon-loader" className={className} />
    ),
    File: ({ className }: { className?: string }) => (
      <span data-testid="icon-file" className={className} />
    ),
    TickCircle: ({ className }: { className?: string }) => (
      <span data-testid="icon-tick" className={className} />
    ),
    CloseCircle: ({ className }: { className?: string }) => (
      <span data-testid="icon-close-circle" className={className} />
    ),
  },
  ProgressBar: ({ value }: { value: number; className?: string }) => (
    <div data-testid="progress-bar" data-value={value} />
  ),
  CardButton: ({ children, onClick, className }: {
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
    variant?: string;
  }) => (
    <button data-testid="card-button" onClick={onClick} className={className}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/DialogContainer", () => ({
  default: ({ children, className }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="dialog-container" className={className}>
      {children}
    </div>
  ),
}));

function makeFiles(count: number): MigrationFile[] {
  return Array.from({ length: count }, (_, i) => ({
    arionHash: `hash-${i}`,
    name: `bucket/file-${i}.txt`,
    size: (i + 1) * 1024 * 1024, // 1MB, 2MB, 3MB, etc.
    status: "pending" as const,
  }));
}

const defaultProps = {
  open: true,
  onCancel: vi.fn(),
  files: makeFiles(3),
  fileCount: 3,
  currentFileIndex: 0,
  overallProgress: 25,
  currentFileName: "bucket/file-0.txt",
};

describe("MigrationProgressDialog", () => {
  it("displays total size when provided", () => {
    const totalSize = 5 * 1024 * 1024 * 1024; // 5 GB
    render(
      <MigrationProgressDialog
        {...defaultProps}
        totalSize={totalSize}
      />,
    );

    expect(screen.getByText("Total: 5 GB")).toBeInTheDocument();
  });

  it("displays total size formatted as MB for smaller migrations", () => {
    const totalSize = 150 * 1024 * 1024; // 150 MB
    render(
      <MigrationProgressDialog
        {...defaultProps}
        totalSize={totalSize}
      />,
    );

    expect(screen.getByText("Total: 150 MB")).toBeInTheDocument();
  });

  it("hides total size when zero", () => {
    render(
      <MigrationProgressDialog
        {...defaultProps}
        totalSize={0}
      />,
    );

    expect(screen.queryByText(/Total:/)).not.toBeInTheDocument();
  });

  it("hides total size when not provided", () => {
    render(
      <MigrationProgressDialog {...defaultProps} />,
    );

    expect(screen.queryByText(/Total:/)).not.toBeInTheDocument();
  });

  it("shows total size alongside failed count", () => {
    const filesWithFailure: MigrationFile[] = [
      { arionHash: "h1", name: "a.txt", size: 1000, status: "completed" },
      { arionHash: "h2", name: "b.txt", size: 2000, status: "failed", error: "timeout" },
      { arionHash: "h3", name: "c.txt", size: 3000, status: "pending" },
    ];

    render(
      <MigrationProgressDialog
        {...defaultProps}
        files={filesWithFailure}
        totalSize={2 * 1024 * 1024 * 1024}
      />,
    );

    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("Total: 2 GB")).toBeInTheDocument();
  });

  it("shows file count progress", () => {
    render(
      <MigrationProgressDialog
        {...defaultProps}
      />,
    );

    expect(screen.getByText("0 / 3 migrated")).toBeInTheDocument();
  });

  it("shows progress percentage", () => {
    render(
      <MigrationProgressDialog
        {...defaultProps}
        overallProgress={42.7}
      />,
    );

    expect(screen.getByText("43% complete")).toBeInTheDocument();
  });

  it("shows cancel button that calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <MigrationProgressDialog
        {...defaultProps}
        onCancel={onCancel}
      />,
    );

    const cancelButton = screen.getByText("Cancel Migration");
    expect(cancelButton).toBeInTheDocument();
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("hides cancel button while cancelling", () => {
    render(
      <MigrationProgressDialog
        {...defaultProps}
        isCancelling={true}
      />,
    );

    expect(screen.queryByText("Cancel Migration")).not.toBeInTheDocument();
  });
});
