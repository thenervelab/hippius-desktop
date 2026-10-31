import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import useDeleteFile, { linksOutcomeNote } from "../use-delete-file";
import { toast } from "sonner";
import { FILES_MUTATED_EVENT } from "@/app/lib/utils/fileMutationEvents";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// `delete_files` is reprogrammed per-test: the Rust command reports partial
// failures in its RESULT (not by rejecting), so both shapes need coverage.
let nextDeleteResult: unknown = { deleted: 1, failed: [] };
let nextInvokeRejects: Error | null = null;

const invokeCalls: Array<[string, unknown]> = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: unknown) => {
    invokeCalls.push([cmd, args]);
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
    warning: vi.fn(),
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

function renderDeleteHook(files: FormattedUserFile[] = [FOLDER]) {
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

  const { result } = renderHook(() => useDeleteFile({ files }), {
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

describe("useDeleteFile: Also turn off its links", () => {
  const SHOT = { ...FOLDER, name: "Screenshot 2026-10-30 at 10.00.00.png", actualFileName: "Screenshot 2026-10-30 at 10.00.00.png", isFolder: false, size: 10 } as FormattedUserFile;
  const NOTES = { ...FOLDER, name: "notes.txt", actualFileName: "notes.txt", isFolder: false, size: 5 } as FormattedUserFile;

  beforeEach(() => {
    invokeCalls.length = 0;
    nextInvokeRejects = null;
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
  });

  it("sends each file's links to turn off with it, and none without the option", async () => {
    nextDeleteResult = { deleted: 2, failed: [], linksTurnedOff: 1, linksFailed: 0 };
    const { result, queryClient } = renderDeleteHook([SHOT, NOTES]);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => {
      result.current.mutate({ turnOffLinks: new Map([[SHOT, ["tok-1"]]]) });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [, args] = invokeCalls.find(([cmd]) => cmd === "delete_files")!;
    const sent = (args as { files: Array<{ name: string; turnOffLinks: string[] }> }).files;
    expect(sent.map((f) => [f.name, f.turnOffLinks])).toEqual([
      [SHOT.name, ["tok-1"]],
      ["notes.txt", []],
    ]);
    expect(toast.success).toHaveBeenCalledWith("Successfully deleted 2 files. Its link is turned off.");
    // The turned-off link leaves Shared Links and the Insights buttons.
    expect(invalidate.mock.calls.some((c) => (c[0] as { queryKey: unknown[] }).queryKey[0] === "shares-list")).toBe(true);
  });

  it("says plainly when a link could not be turned off", async () => {
    nextDeleteResult = { deleted: 1, failed: [], linksTurnedOff: 0, linksFailed: 1 };
    const { result } = renderDeleteHook([SHOT]);
    await act(async () => {
      result.current.mutate({ turnOffLinks: new Map([[SHOT, ["tok-1"]]]) });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.warning).toHaveBeenCalledWith("Deleted. 1 link couldn't be turned off: open Shared Links to turn it off.");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("words the links outcome", () => {
    expect(linksOutcomeNote(0, 0)).toBeNull();
    expect(linksOutcomeNote(3, 0)).toBe("3 links are turned off.");
    expect(linksOutcomeNote(1, 2)).toBe("2 links couldn't be turned off: open Shared Links to turn them off.");
  });
});
