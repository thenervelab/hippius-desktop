import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useDriveFailures,
  useFileFailure,
  useRetryFailure,
} from "@/app/lib/hooks/useFileFailure";
import type { FileFailureRecord } from "@/app/lib/types/fileFailure";

const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return { tauri: makeTauriMock() };
});
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
const { tauri } = h;

const rec = (relativePath: string): FileFailureRecord =>
  ({
    relativePath,
    fileName: relativePath.split("/").pop(),
    kind: "serverError",
  }) as unknown as FileFailureRecord;

function makeHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "TestFailureWrapper";
  return { client, wrapper: Wrapper };
}

beforeEach(() => tauri.reset());

describe("useDriveFailures", () => {
  it("is disabled (no fetch) without a label", async () => {
    const { result } = renderHook(() => useDriveFailures(undefined), {
      wrapper: makeHarness().wrapper,
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("fetches the drive's failures scoped to the label", async () => {
    tauri.onInvoke("get_drive_failures", () => [rec("a.txt")]);
    const { result } = renderHook(() => useDriveFailures("photos"), {
      wrapper: makeHarness().wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([rec("a.txt")]);
    expect(tauri.core.invoke).toHaveBeenCalledWith("get_drive_failures", {
      label: "photos",
    });
  });
});

describe("useFileFailure", () => {
  it("returns null when the path is undefined", () => {
    const { result } = renderHook(() => useFileFailure("photos", undefined), {
      wrapper: makeHarness().wrapper,
    });
    expect(result.current).toBeNull();
  });

  it("matches the record by its drive-relative path", async () => {
    tauri.onInvoke("get_drive_failures", () => [rec("a.txt"), rec("b.txt")]);
    const { result } = renderHook(() => useFileFailure("photos", "b.txt"), {
      wrapper: makeHarness().wrapper,
    });
    await waitFor(() => expect(result.current).toEqual(rec("b.txt")));
  });

  // Two files with one name in different folders: matching by basename gave
  // both rows the first one's failure, so a healthy file showed another
  // file's error (and its Retry targeted the wrong path).
  it("tells same-named files in different folders apart", async () => {
    tauri.onInvoke("get_drive_failures", () => [rec("Trips/notes.txt"), rec("Work/notes.txt")]);
    const work = renderHook(() => useFileFailure("photos", "Work/notes.txt"), {
      wrapper: makeHarness().wrapper,
    });
    await waitFor(() => expect(work.result.current).toEqual(rec("Work/notes.txt")));

    const root = renderHook(() => useFileFailure("photos", "notes.txt"), {
      wrapper: makeHarness().wrapper,
    });
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalled());
    expect(root.result.current, "a root file with the same name has no failure").toBeNull();
  });

  it("returns null when no record matches after the fetch lands", async () => {
    tauri.onInvoke("get_drive_failures", () => [rec("a.txt")]);
    const { result } = renderHook(() => useFileFailure("photos", "missing.txt"), {
      wrapper: makeHarness().wrapper,
    });
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});

describe("useRetryFailure", () => {
  it("retryFile invokes per-path and invalidates the drive query on success", async () => {
    tauri.onInvoke("retry_file_failure", () => undefined);
    const { client, wrapper } = makeHarness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRetryFailure("photos"), { wrapper });

    await act(async () => {
      await result.current.retryFile.mutateAsync("photos/a.txt");
    });

    expect(tauri.core.invoke).toHaveBeenCalledWith("retry_file_failure", {
      label: "photos",
      path: "photos/a.txt",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["drive-failures", "photos"] });
  });

  it("retryAll invokes for the whole drive and invalidates", async () => {
    tauri.onInvoke("retry_all_failures", () => undefined);
    const { client, wrapper } = makeHarness();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRetryFailure("docs"), { wrapper });

    await act(async () => {
      await result.current.retryAll.mutateAsync();
    });

    expect(tauri.core.invoke).toHaveBeenCalledWith("retry_all_failures", { label: "docs" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["drive-failures", "docs"] });
  });
});
