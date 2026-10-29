// The Shared Drives page sums shared folders' sizes with
// `useFolderGrantStatsList` while each row reads its own with
// `useFolderGrantStats`. They must share one cache entry per folder, or
// every folder is listed twice on the server.

import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const folderGrantStats = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", () => ({ folderGrantStats }));

import { useFolderGrantStats, useFolderGrantStatsList } from "../useFolderGrantStats";

const grant = (pathPrefix: string) => ({ ownerSs58: "5Owner", folderHash: "ab".repeat(8), pathPrefix });

describe("useFolderGrantStatsList", () => {
  it("answers per folder from the same cache the rows read", async () => {
    folderGrantStats.mockImplementation(async (_o: string, _h: string, path: string) =>
      path === "/Bad" ? Promise.reject(new Error("no")) : { totalBytes: 10, fileCount: 2, truncated: false },
    );
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const grants = [grant("/A"), grant("/Bad")];
    const { result } = renderHook(
      () => ({ list: useFolderGrantStatsList(grants), row: useFolderGrantStats(grants[0]!) }),
      { wrapper },
    );
    expect(result.current.list.map((s) => s.kind)).toEqual(["loading", "loading"]);
    await waitFor(() => expect(result.current.list.map((s) => s.kind)).toEqual(["ready", "failed"]));
    expect(result.current.row).toEqual(result.current.list[0]);
    // One request for "/A" though two hooks read it; "/Bad" is retried once.
    expect(folderGrantStats.mock.calls.filter((c) => c[2] === "/A")).toHaveLength(1);
  });
});
