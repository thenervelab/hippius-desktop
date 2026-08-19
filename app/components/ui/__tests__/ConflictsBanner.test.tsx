// Failure-path coverage for the conflict banner's "Sync Now" flow.
//
// Historical bug (user report 2026-07-28): a failed reviewed sync looked
// identical to a successful one — `handleSync` unconditionally dropped the
// banner and closed the dialog, and the hook's error state had no consumer.
//
// The dialog now closes on submit regardless of outcome and hands progress to
// the sidebar sync widget (report 2026-07-31: `sync_with_conflict_resolutions`
// runs the whole cycle inline, so keeping the modal open meant minutes of a
// spinner with Cancel disabled). The guarantee that mattered is unchanged and
// still pinned below: a sync that fails or never starts keeps the banner AND
// the user's resolutions, so reopening the dialog resumes the review rather
// than restarting it. That is what moving the state up to the banner buys.

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

async function openReview() {
  fireEvent.click(screen.getByRole("button", { name: /review & resolve/i }));
  await screen.findByText("Review Changes");
}

/** Open the dialog, resolve the conflict via "Apply to all", press Sync Now. */
async function reviewAndSync() {
  await openReview();
  // Bulk-resolve — the per-row Radix select is awkward in jsdom, and the
  // bulk control drives the same `resolutions` state.
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

  it("SyncInProgress keeps the banner and toasts 'retry shortly'", async () => {
    // The wire shape of AppError::NotReady(SyncInProgress) — a plain object.
    invokeMock.mockRejectedValue({
      kind: "NotReady",
      subkind: "SYNC_IN_PROGRESS",
      message: "Sync is in progress, please wait",
    });
    renderBanner();

    await reviewAndSync();

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());
    // The reviewed sync never started, so the drive still needs resolving.
    expect(screen.getByText(/1 file conflict detected/i)).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("preserves the user's resolutions when the sync never started", async () => {
    // The point of lifting `resolutions` out of the dialog: the retry must
    // resume the review, not restart it. Previously the dialog owned the map
    // and any remount (or a re-emitted `staged`) discarded it.
    invokeMock.mockRejectedValue({
      kind: "NotReady",
      subkind: "SYNC_IN_PROGRESS",
      message: "Sync is in progress, please wait",
    });
    renderBanner();

    await reviewAndSync();
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled());

    // Reopen: the conflict is still resolved to "Keep Both", so Sync Now is
    // immediately enabled rather than gated on re-picking.
    await openReview();
    const syncNow = await screen.findByRole("button", { name: /sync now/i });
    expect(syncNow).toBeEnabled();

    invokeMock.mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(syncNow);
    });
    expect(invokeMock).toHaveBeenLastCalledWith("sync_with_conflict_resolutions", {
      label: "Desktop",
      resolutions: { deadbeef: "keep_both" },
    });
  });

  it("a real failure keeps the banner and surfaces an error toast", async () => {
    invokeMock.mockRejectedValue({
      kind: "Hcfs",
      message: "Network error: error sending request",
    });
    renderBanner();

    await reviewAndSync();

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const [, options] = toastMock.error.mock.calls[0] as [string, { description?: string }];
    expect(options?.description).toContain("Network error");
    // The banner survives so the user can retry. (On a genuine engine failure
    // the row is also later unmounted by the `hcfs_sync_error` event via
    // ConflictEventListener, which is out of scope for this render.)
    expect(screen.getByText(/1 file conflict detected/i)).toBeInTheDocument();
  });

  it("closes the dialog on submit and hands progress to the sync widget", async () => {
    // A never-settling IPC stands in for the long inline cycle from the
    // report. The modal must not sit there spinning with Cancel disabled.
    invokeMock.mockImplementation(() => new Promise(() => {}));
    renderBanner();

    await reviewAndSync();

    expect(screen.queryByText("Review Changes")).not.toBeInTheDocument();
    // Still unresolved as far as the app knows, so the banner stays put.
    expect(screen.getByText(/1 file conflict detected/i)).toBeInTheDocument();
  });
});
