import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import ExclusionsDialog from "../ExclusionsDialog";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
  },
}));

// The dialog shell renders its children inline in tests; we only care about the
// exclusion list behaviour, not the frame chrome.
vi.mock("@/components/ui/FramedDialog", () => ({
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

function renderDialog() {
  return render(<ExclusionsDialog open label="tags" onClose={() => {}} />);
}

describe("ExclusionsDialog", () => {
  beforeEach(() => {
    invoke.mockReset();
    toastError.mockReset();
  });

  it("lists the drive's current patterns", async () => {
    invoke.mockResolvedValueOnce([
      { pattern: "node_modules/", display: "node_modules/" },
      { pattern: "*.tmp", display: "*.tmp" },
    ]);

    renderDialog();

    expect(await screen.findByText("node_modules/")).toBeInTheDocument();
    expect(screen.getByText("*.tmp")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("list_exclude_patterns", {
      label: "tags",
    });
  });

  it("adds a pattern and shows it without a refetch round trip", async () => {
    invoke.mockResolvedValueOnce([]); // initial list
    invoke.mockResolvedValueOnce(true); // add_exclude_pattern

    renderDialog();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "dist/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("add_exclude_pattern", {
        label: "tags",
        pattern: "dist/",
      }),
    );
    expect(await screen.findByText("dist/")).toBeInTheDocument();
  });

  it("surfaces the backend's rejection instead of adding the pattern", async () => {
    // Rust owns the pattern rules — notably refusing a catch-all like `*`,
    // which would silently stop the whole drive syncing. The dialog must show
    // that reason rather than optimistically listing the pattern.
    invoke.mockResolvedValueOnce([]);
    invoke.mockRejectedValueOnce({
      kind: "Validation",
      message:
        "Pattern would exclude the entire folder — nothing would sync. Use a more specific pattern.",
    });

    renderDialog();
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), {
      target: { value: "*" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toMatch(/entire folder/i);
    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });

  it("removes a pattern", async () => {
    invoke.mockResolvedValueOnce([
      { pattern: "node_modules/", display: "node_modules/" },
    ]);
    invoke.mockResolvedValueOnce(true); // remove_exclude_pattern

    renderDialog();
    await screen.findByText("node_modules/");

    fireEvent.click(
      screen.getByRole("button", { name: /remove node_modules\//i }),
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("remove_exclude_pattern", {
        label: "tags",
        pattern: "node_modules/",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("node_modules/")).not.toBeInTheDocument(),
    );
  });

  it("explains an empty list rather than rendering blank", async () => {
    invoke.mockResolvedValueOnce([]);
    renderDialog();
    expect(await screen.findByText(/nothing is excluded/i)).toBeInTheDocument();
  });
});

describe("ExclusionsDialog literal exclusions", () => {
  beforeEach(() => {
    invoke.mockReset();
    toastError.mockReset();
  });

  // A file excluded from the Sync Issues dialog is stored as an escaped glob
  // (`[[]` for `[`). Rust pairs that stored line with the file name; the
  // dialog must show the name and still remove by the stored line.
  it("shows a literal exclusion as its file name and removes it by the stored line", async () => {
    const stored = "Movies/Blade Runner [[]2049[]].mkv";
    const display = "Movies/Blade Runner [2049].mkv";
    invoke.mockResolvedValueOnce([{ pattern: stored, display }]);
    invoke.mockResolvedValueOnce(true); // remove_exclude_pattern

    renderDialog();

    expect(await screen.findByText(display)).toBeInTheDocument();
    expect(screen.queryByText(stored)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `Remove ${display}` }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("remove_exclude_pattern", {
        label: "tags",
        pattern: stored,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(display)).not.toBeInTheDocument(),
    );
  });
});
