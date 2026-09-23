import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useDriveScopedSearch } from "@/app/lib/hooks/useDriveScopedSearch";
import { useGlobalFileSearch } from "@/app/lib/hooks/useGlobalFileSearch";

// Both server-backed searches share one rule: a term under three characters
// is never sent, because the server answers it with an empty page that the UI
// cannot tell apart from "no files match".

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Long enough for a zero-ms debounce and a query that was going to fire. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const HIT = { name: "report.pdf", actualFileName: "report.pdf" };

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("search_files", () => [HIT]);
  tauri.onInvoke("search_files_in_drive", () => [HIT]);
});

describe("useGlobalFileSearch minimum term length", () => {
  it("does not call the backend for a two-character term", async () => {
    const { result } = renderHook(
      () => useGlobalFileSearch({ accountId: "5acct", searchTerm: " ab ", debounceMs: 0 }),
      { wrapper },
    );

    await settle();

    expect(tauri.core.invoke).not.toHaveBeenCalled();
    expect(result.current).toEqual({ data: [], isFetching: false });
  });

  it("searches once the term reaches three characters, trimmed", async () => {
    const { result } = renderHook(
      () => useGlobalFileSearch({ accountId: "5acct", searchTerm: " abc ", debounceMs: 0 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(tauri.core.invoke).toHaveBeenCalledWith("search_files", {
      accountId: "5acct",
      params: { query: "abc", limit: 50 },
    });
  });
});

describe("useDriveScopedSearch minimum term length", () => {
  it("does not call the backend for a short term with no filter", async () => {
    const { result } = renderHook(
      () =>
        useDriveScopedSearch({
          accountId: "5acct",
          label: "Camera Uploads",
          criteria: { searchTerm: "ab" },
          debounceMs: 0,
        }),
      { wrapper },
    );

    await settle();

    expect(tauri.core.invoke).not.toHaveBeenCalled();
    expect(result.current).toEqual({ data: [], isFetching: false });
  });

  // The filter still means something without the term, so the search runs on
  // the filter alone rather than going blank until a third character arrives.
  it("runs filter-only when a short term sits on an extension filter", async () => {
    const { result } = renderHook(
      () =>
        useDriveScopedSearch({
          accountId: "5acct",
          label: "Camera Uploads",
          criteria: { searchTerm: "ab", fileExtensions: ["pdf"] },
          debounceMs: 0,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(tauri.core.invoke).toHaveBeenCalledWith("search_files_in_drive", {
      accountId: "5acct",
      label: "Camera Uploads",
      params: { query: undefined, fileExtension: "pdf" },
    });
  });

  it("sends the term once it is long enough", async () => {
    const { result } = renderHook(
      () =>
        useDriveScopedSearch({
          accountId: "5acct",
          label: "Camera Uploads",
          criteria: { searchTerm: "rep" },
          debounceMs: 0,
        }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(tauri.core.invoke).toHaveBeenCalledWith("search_files_in_drive", {
      accountId: "5acct",
      label: "Camera Uploads",
      params: { query: "rep", fileExtension: undefined },
    });
  });
});
