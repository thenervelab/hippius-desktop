import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

import useDeleteFile from "../use-delete-file";
import { toast } from "sonner";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const invokeCalls: Array<[string, Record<string, unknown>]> = [];
let moveResult: unknown;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invokeCalls.push([cmd, args]);
    if (cmd === "move_to_trash") return Promise.resolve(moveResult);
    if (cmd === "undo_move_to_trash") return Promise.resolve({ restored: 1, leftInTrash: 0 });
    if (cmd === "release_trash_hold") return Promise.resolve(null);
    return Promise.resolve({ deleted: 1, failed: [] });
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
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

const FILE = {
  name: "report.pdf",
  actualFileName: "Docs/report.pdf",
  source: "/Users/me/Hippius/Docs/report.pdf",
  label: "hippius",
  isFolder: false,
  isAssigned: true,
  size: 10,
} as unknown as FormattedUserFile;

function renderDeleteHook() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const store = createStore();
  store.set(queryClientAtom, queryClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>{children}</Provider>
    </QueryClientProvider>
  );
  return renderHook(() => useDeleteFile({ files: [FILE] }), { wrapper }).result;
}

describe("useDeleteFile in trash mode", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    vi.clearAllMocks();
    moveResult = { trashed: 1, failed: [], hold: "123-abc", undoable: true };
  });

  it("moves to Trash, never calls the permanent delete, and offers Undo", async () => {
    const result = renderDeleteHook();
    await act(async () => {
      result.current.mutate({ mode: "trash" });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    const commands = invokeCalls.map(([cmd]) => cmd);
    expect(commands).toContain("move_to_trash");
    expect(commands).not.toContain("delete_files");
    const args = invokeCalls.find(([cmd]) => cmd === "move_to_trash")![1];
    expect(args.accountId).toBe("5TestAddress");
    expect(String(args.jobId)).toMatch(/^trash-/);
    expect(args.files).toEqual([{ name: "Docs/report.pdf", source: FILE.source, label: "hippius" }]);

    const [title, options] = vi.mocked(toast.success).mock.calls[0] as [string, { action?: { label: string; onClick: () => void }; onDismiss?: () => void }];
    expect(title).toBe("Moved “report.pdf” to Trash");
    expect(options.action?.label).toBe("Undo");

    await act(async () => {
      options.action!.onClick();
    });
    await waitFor(() => expect(invokeCalls.some(([cmd]) => cmd === "undo_move_to_trash")).toBe(true));
    // Undo spent the hold: dismissing the toast afterwards releases nothing.
    options.onDismiss?.();
    expect(invokeCalls.some(([cmd]) => cmd === "release_trash_hold")).toBe(false);
  });

  it("releases the hold when the toast closes without Undo", async () => {
    const result = renderDeleteHook();
    await act(async () => {
      result.current.mutate({ mode: "trash" });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const options = vi.mocked(toast.success).mock.calls[0][1] as { onAutoClose?: () => void };
    options.onAutoClose?.();
    expect(invokeCalls.filter(([cmd]) => cmd === "release_trash_hold")).toEqual([["release_trash_hold", { hold: "123-abc" }]]);
  });

  it("offers no Undo when Rust says it cannot undo", async () => {
    moveResult = { trashed: 1, failed: [], hold: "123-abc", undoable: false };
    const result = renderDeleteHook();
    await act(async () => {
      result.current.mutate({ mode: "trash" });
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const options = vi.mocked(toast.success).mock.calls[0][1] as { action?: unknown };
    expect(options.action).toBeUndefined();
  });

  it("reports Rust's reason when nothing went to Trash", async () => {
    moveResult = { trashed: 0, failed: [{ name: "x", error: "“report.pdf” hasn't finished uploading yet." }], hold: null, undoable: false };
    const result = renderDeleteHook();
    await act(async () => {
      result.current.mutate({ mode: "trash" });
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const [title, options] = vi.mocked(toast.error).mock.calls[0] as [string, { description: string }];
    expect(title).toBe("Couldn't move “report.pdf” to Trash");
    expect(options.description).toContain("hasn't finished uploading");
  });

  it("without a mode keeps today's permanent delete", async () => {
    const result = renderDeleteHook();
    await act(async () => {
      result.current.mutate({});
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(invokeCalls.map(([cmd]) => cmd)).toContain("delete_files");
    expect(invokeCalls.map(([cmd]) => cmd)).not.toContain("move_to_trash");
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe('Successfully deleted "Docs/report.pdf"');
  });
});
