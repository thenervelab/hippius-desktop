import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import React from "react";
import { toast } from "sonner";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { StarredItem, StarredListing } from "@/app/lib/tauri/starred";
import { useStars } from "../useStars";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

let account: string | null = "5Me";
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: account }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));

const OWNER = "5Me";
const HASH = "0123456789abcdef";
const FILE_A = "aa".repeat(32);
const FILE_B = "bb".repeat(32);
const keyOf = (id: string) => `${OWNER}|${HASH}|f:${id}`;

function file(id: string, overrides: Partial<FormattedUserFile> = {}): FormattedUserFile {
  return {
    name: `${id.slice(0, 2)}.pdf`,
    actualFileName: `${id.slice(0, 2)}.pdf`,
    createdAt: 0,
    arionHash: id,
    arionCid: "",
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    label: "Docs",
    syncStatus: "synced",
    ...overrides,
  };
}

function listed(id: string): StarredItem {
  return {
    key: keyOf(id),
    kind: "file",
    ownerSs58: OWNER,
    folderHash: HASH,
    name: "x.pdf",
    path: "x.pdf",
    fileId: id,
    size: 1,
    createdAt: 1,
    fileCount: null,
    isOwn: true,
    driveName: "Docs",
    location: "Docs",
    openLabel: "Docs",
    openRemote: false,
    openName: null,
    openPath: "",
    uploadedBy: null,
    uploadedByName: null,
    arionCid: "",
  };
}

let listing: StarredListing;

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createStore();
  store.set(queryClientAtom, queryClient);
  const wrapper = ({ children }: { children: React.ReactNode }) => <Provider store={store}>{children}</Provider>;
  return renderHook(() => useStars(["Docs"]), { wrapper });
}

beforeEach(() => {
  tauri.reset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  account = "5Me";
  listing = { available: true, items: [listed(FILE_A)] };
  tauri.onInvoke("list_starred", () => listing);
  tauri.onInvoke("star_scopes", (args) => {
    const labels = (args?.labels as string[]) ?? [];
    return Object.fromEntries(labels.map((l) => [l, { ownerSs58: OWNER, folderHash: HASH, rootPath: "" }]));
  });
});

describe("useStars", () => {
  it("reads the row's own favorite first, then the Starred list", async () => {
    const { result } = setup();
    // In the list, the listing silent about it.
    await waitFor(() => expect(result.current.isStarred(file(FILE_A))).toBe(true));
    // The listing's answer wins over the list.
    expect(result.current.isStarred(file(FILE_A, { favorite: false }))).toBe(false);
    expect(result.current.isStarred(file(FILE_B, { favorite: true }))).toBe(true);
    expect(result.current.isStarred(file(FILE_B))).toBe(false);
  });

  it("stars at once, keeps it under Rust's key, and says so", async () => {
    let resolve: (v: unknown) => void = () => {};
    tauri.onInvoke("set_star", () => new Promise((r) => (resolve = r)));
    const { result } = setup();
    await waitFor(() => expect(result.current.isStarred(file(FILE_A))).toBe(true));

    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = result.current.toggleRow(file(FILE_B));
    });
    // Optimistic: starred before the server answers.
    await waitFor(() => expect(result.current.isStarred(file(FILE_B))).toBe(true));
    const sent = tauri.core.invoke.mock.calls.find(([cmd]) => cmd === "set_star");
    expect(sent?.[1]).toEqual({
      accountId: "5Me",
      target: { kind: "file", name: "bb.pdf", label: "Docs", fileId: FILE_B },
      favorite: true,
    });
    await act(async () => {
      resolve({ key: keyOf(FILE_B), favorite: true });
      await done;
    });
    expect(result.current.isStarred(file(FILE_B, { favorite: false }))).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('"bb.pdf" added to Starred');
  });

  it("puts the star back and shows Rust's sentence when the server refuses", async () => {
    tauri.onInvoke("set_star", () => {
      throw { kind: "Validation", message: "You can star up to 1,000 items. Unstar some to add more." };
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.isStarred(file(FILE_A))).toBe(true));
    await act(async () => {
      await result.current.toggleRow(file(FILE_B));
    });
    expect(result.current.isStarred(file(FILE_B))).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("You can star up to 1,000 items. Unstar some to add more.");
  });

  it("unstars a selection that is all starred in one batch, with one toast", async () => {
    tauri.onInvoke("set_stars", (args) => ({
      done: ((args?.targets as Array<{ fileId: string }>) ?? []).map((t) => ({ key: keyOf(t.fileId), favorite: false })),
      failed: [],
      full: false,
    }));
    const { result } = setup();
    const rows = [file(FILE_A), file(FILE_B, { favorite: true })];
    await waitFor(() => expect(result.current.allStarred(rows)).toBe(true));
    await act(async () => {
      await result.current.toggleRows(rows);
    });
    const sent = tauri.core.invoke.mock.calls.find(([cmd]) => cmd === "set_stars");
    expect(sent?.[1]).toMatchObject({ favorite: false });
    expect(result.current.isStarred(file(FILE_A))).toBe(false);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("2 items removed from Starred");
  });

  it("forgets this session's stars when the account changes", async () => {
    tauri.onInvoke("set_star", () => ({ key: keyOf(FILE_B), favorite: true }));
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.isStarred(file(FILE_A))).toBe(true));
    await act(async () => {
      await result.current.toggleRow(file(FILE_B));
    });
    expect(result.current.isStarred(file(FILE_B, { favorite: false }))).toBe(true);
    account = "5Other";
    rerender();
    // Another account's view never shows the last one's toggle.
    expect(result.current.isStarred(file(FILE_B, { favorite: false }))).toBe(false);
  });
});
