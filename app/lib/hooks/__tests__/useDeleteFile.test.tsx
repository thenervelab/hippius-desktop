import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import useDeleteFile from "../use-delete-file";
import { FILES_MUTATED_EVENT } from "@/app/lib/utils/fileMutationEvents";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// `delete_files` is reprogrammed per-test: the Rust command reports partial
// failures in its RESULT (not by rejecting), so both shapes need coverage.
let nextDeleteResult: unknown = { deleted: 1, failed: [] };
let nextInvokeRejects: Error | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => {
    if (nextInvokeRejects) return Promise.reject(nextInvokeRejects);
    return Promise.resolve(nextDeleteResult);
  }),
}));

vi.mock("@/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5TestAddress" }),
}));

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const FOLDER: FormattedUserFile = {
  name: "Nested",
  actualFileName: "Parent/Nested",
  size: 0,
  createdAt: 0,
  arionHash: "",
  arionCid: "",
  source: "/Users/me/Hippius/Parent/Nested",
  minerIds: [],
  isAssigned: true,
  lastChargedAt: 0,
  isFolder: true,
  type: "private",
  isErasureCoded: false,
  mainReqHash: "",
  label: "hippius",
} as FormattedUserFile;

function renderDeleteHook() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const store = createStore();
  store.set(queryClientAtom, queryClient);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );

  const { result } = renderHook(() => useDeleteFile({ files: [FOLDER] }), {
    wrapper,
  });
  return { result, queryClient };
}

describe("useDeleteFile — nested-listing invalidation", () => {
  let mutatedEvents: number;
  let listener: () => void;

  beforeEach(() => {
    nextDeleteResult = { deleted: 1, failed: [] };
    nextInvokeRejects = null;
    mutatedEvents = 0;
    listener = () => {
      mutatedEvents += 1;
    };
    window.addEventListener(FILES_MUTATED_EVENT, listener);
  });

  afterEach(() => {
    window.removeEventListener(FILES_MUTATED_EVENT, listener);
  });

  // Regression: nested folder listings (DriveContainer's subfolder view and
  // ExpandedFolderRows) are plain useState + `list_sync_folder_grouped`, NOT
  // TanStack-cached, so the hook's query refetches never reach them. They
  // refresh on this window event (and on `sync_files_completed_changed`).
  // Deleting the last entry of a folder produces NO file changes to sync, so
  // hcfs-client ends the cycle `NoChanges` and never emits `SyncCompleted` —
  // the view stayed on the deleted row until the user navigated out and back.
  it("dispatches the files-mutated event after a successful delete", async () => {
    const { result } = renderDeleteHook();

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mutatedEvents).toBe(1);
  });

  it("refetches the drive file list alongside the event", async () => {
    const { result, queryClient } = renderDeleteHook();
    const refetchSpy = vi.spyOn(queryClient, "refetchQueries");

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const refetchedKeys = refetchSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey[0],
    );
    expect(refetchedKeys).toContain("userIpfsFiles");
    expect(refetchedKeys).toContain("recent-files");
  });

  it("does not dispatch when the delete reports per-file failures", async () => {
    nextDeleteResult = {
      deleted: 0,
      failed: [{ name: "Parent/Nested", error: "permission denied" }],
    };

    const { result } = renderDeleteHook();

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mutatedEvents).toBe(0);
  });

  it("does not dispatch when the IPC rejects", async () => {
    nextInvokeRejects = new Error("ipc transport failure");

    const { result } = renderDeleteHook();

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mutatedEvents).toBe(0);
  });
});
