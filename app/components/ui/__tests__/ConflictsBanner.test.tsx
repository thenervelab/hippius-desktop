// Failure-path coverage for the conflict banner's "Sync Now" flow.
//
// The historical bug (user report 2026-07-28): a failed reviewed sync looked
// identical to a successful one — `handleSync` unconditionally dropped the
// banner and closed the dialog, and the hook's error state had no consumer.
// These tests pin the split: success dismisses everything; a
// `NotReady(SyncInProgress)` rejection (auto-sync loop holds the drive
// manager) keeps the dialog open with the user's resolutions and explains
// itself via a toast.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import ConflictsBanner from "../ConflictsBanner";
import { pendingConflictsAtom } from "@/app/lib/store/syncAtoms";
import type { StagedChanges } from "@/app/lib/types/syncTypes";

// vi.hoisted so the mock objects exist when the (hoisted) vi.mock factories
// run — referencing a plain top-level const from a factory is a TDZ error.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Toasts are the failure feedback under test — capture them.
const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({
  toast: toastMock,
}));

const staged: StagedChanges = {
  uploads: [],
  downloads: [],
  local_deletes: [],
  remote_deletes: [],
  conflicts: [
    {
      file_id: "deadbeef",
      path: "notes/todo.txt",
      conflict_type: "modify_modify",
      has_local: true,
      has_remote: true,
    },
  ],
  unchanged_count: 0,
};

function renderBanner() {
  const store = createStore();
  store.set(pendingConflictsAtom, new Map([["Desktop", staged]]));
  render(
    <Provider store={store}>
      <ConflictsBanner />
    </Provider>
  );
  return store;
}

/** Open the dialog, resolve the conflict via "Apply to all", press Sync Now. */
async function reviewAndSync() {
  fireEvent.click(screen.getByRole("button", { name: /review & resolve/i }));
  await screen.findByText("Review Changes");
  // Bulk-resolve — the per-row Radix select is awkward in jsdom, and the
  // bulk bar drives the same `resolutions` state.
  fireEvent.click(screen.getByRole("button", { name: /keep both/i }));
  const syncNow = await screen.findByRole("button", { name: /sync now/i });
  await waitFor(() => expect(syncNow).toBeEnabled());
  // The click kicks off the async IPC; flushing it inside act() keeps the
  // hook's post-rejection state updates (isSyncing/error) inside the render
  // lifecycle instead of tripping the act() warning.
  await act(async () => {
    fireEvent.click(syncNow);
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  toastMock.warning.mockReset();
  toastMock.error.mockReset();
  toastMock.success.mockReset();
});

describe("ConflictsBanner reviewed-sync outcomes", () => {
  it("success drops the banner and closes the dialog", async () => {
    invokeMock.mockResolvedValue(undefined);
    renderBanner();

    expect(screen.getByText(/1 file conflict detected/i)).toBeInTheDocument();
    await reviewAndSync();

    await waitFor(() =>
      expect(screen.queryByText(/1 file conflict detected/i)).not.toBeInTheDocument()
    );
    expect(screen.queryByText("Review Changes")).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("sync_with_conflict_resolutions", {
      label: "Desktop",
      resolutions: { deadbeef: "keep_both" },
    });
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("SyncInProgress keeps the dialog and banner, and toasts 'retry shortly'", async () => {
    // The wire shape of AppError::NotReady(SyncInProgress) — a plain object.
    invokeMock.mockRejectedValue({
      kind: "NotReady",
      subkind: "SYNC_IN_PROGRESS",
      message: "Sync is in progress, please wait",
    });
    renderBanner();

    await reviewAndSync();

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    // Dialog stays open so the user's chosen resolutions survive the retry.
    expect(screen.getByText("Review Changes")).toBeInTheDocument();
    expect(screen.getByText(/1 file conflict detected/i)).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("a real failure keeps the dialog and surfaces an error toast", async () => {
    invokeMock.mockRejectedValue({
      kind: "Hcfs",
      message: "Network error: error sending request",
    });
    renderBanner();

    await reviewAndSync();

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const [, options] = toastMock.error.mock.calls[0] as [string, { description?: string }];
    expect(options?.description).toContain("Network error");
    // The dialog is not closed by the click handler itself; on a genuine
    // engine failure the row is later unmounted by the `hcfs_sync_error`
    // event (ConflictEventListener), which is out of scope for this render.
    expect(screen.getByText("Review Changes")).toBeInTheDocument();
  });
});
