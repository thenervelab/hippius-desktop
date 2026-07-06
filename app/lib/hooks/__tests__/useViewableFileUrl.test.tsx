import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useViewableFileUrl } from "@/app/lib/hooks/useViewableFileUrl";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return {
    tauri: makeTauriMock(),
    state: {
      polkadotAddress: "5auth" as string | null,
      fileUrl: { isLocal: false, url: "" } as { isLocal: boolean; url: string },
    },
  };
});
// Extend the shared core mock with convertFileSrc (the hook imports both).
vi.mock("@tauri-apps/api/core", () => ({
  ...h.tauri.core,
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@/app/lib/utils/fileUrlResolver", () => ({
  getFileUrl: () => h.state.fileUrl,
}));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: h.state.polkadotAddress }),
}));
const { tauri, state } = h;

function file(overrides: Partial<FormattedUserFile>): FormattedUserFile {
  return {
    name: "a.jpg",
    actualFileName: "a.jpg",
    source: "/Users/me/Hippius/a.jpg",
    ...overrides,
  } as FormattedUserFile;
}

beforeEach(() => {
  tauri.reset();
  state.polkadotAddress = "5auth";
  state.fileUrl = { isLocal: false, url: "" };
});

describe("useViewableFileUrl", () => {
  it("returns the empty state for a null file and never invokes", async () => {
    const { result } = renderHook(() => useViewableFileUrl(null));
    expect(result.current).toEqual({ url: "", localPath: "", isLoading: false, error: null });
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("serves a synced on-disk file directly, with no network", async () => {
    state.fileUrl = { isLocal: true, url: "asset://local" };
    const { result } = renderHook(() =>
      useViewableFileUrl(file({ syncStatus: "synced", source: "/Users/me/Hippius/a.jpg" }))
    );

    await waitFor(() => expect(result.current.url).toBe("asset://local"));
    expect(result.current.localPath).toBe("/Users/me/Hippius/a.jpg");
    expect(result.current.isLoading).toBe(false);
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("reroutes a pending search hit through the cloud even though it has a source", async () => {
    // pending + fileId means the bytes aren't on disk yet — must NOT serve the
    // would-be local path.
    state.fileUrl = { isLocal: true, url: "asset://would-be-local" };
    tauri.onInvoke("cache_remote_file", () => "/cache/a.jpg");
    const { result } = renderHook(() =>
      useViewableFileUrl(
        file({ syncStatus: "pending", fileId: "fid", label: "photos" })
      )
    );

    await waitFor(() => expect(result.current.url).toBe("asset:///cache/a.jpg"));
    expect(tauri.core.invoke).toHaveBeenCalledWith(
      "cache_remote_file",
      expect.objectContaining({ accountId: "5auth", label: "photos", fileId: "fid" })
    );
  });

  it("reports a cannot-preview error when the cloud path lacks identity", async () => {
    state.fileUrl = { isLocal: false, url: "" }; // not on disk
    const { result } = renderHook(() =>
      useViewableFileUrl(file({ source: undefined, fileId: undefined }))
    );

    await waitFor(() => expect(result.current.error).toBe("This file can't be previewed."));
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("downloads + converts a cloud-only file", async () => {
    state.fileUrl = { isLocal: false, url: "" };
    tauri.onInvoke("cache_remote_file", () => "/cache/remote.jpg");
    const { result } = renderHook(() =>
      useViewableFileUrl(file({ source: undefined, fileId: "fid", label: "photos" }))
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.url).toBe("asset:///cache/remote.jpg");
    expect(result.current.localPath).toBe("/cache/remote.jpg");
    expect(result.current.error).toBeNull();
  });

  it("discards a superseded download when the file changes mid-flight (cancel guard)", async () => {
    // The hook's `cancelled` flag must drop the OLD file's resolved path when
    // `file` identity changes while cache_remote_file is still in flight —
    // otherwise a slow first download clobbers the newly-selected file.
    state.fileUrl = { isLocal: false, url: "" };
    let resolveA: (p: string) => void = () => {};
    const aPromise = new Promise<string>((r) => {
      resolveA = r;
    });
    tauri.onInvoke("cache_remote_file", (args) =>
      (args as { fileId: string }).fileId === "A" ? aPromise : "/cache/B.jpg"
    );

    const { result, rerender } = renderHook(
      ({ f }: { f: FormattedUserFile }) => useViewableFileUrl(f),
      {
        initialProps: {
          f: file({ source: undefined, fileId: "A", label: "photos", actualFileName: "A.jpg" }),
        },
      }
    );

    await waitFor(() => expect(result.current.isLoading).toBe(true)); // A in flight

    rerender({
      f: file({ source: undefined, fileId: "B", label: "photos", actualFileName: "B.jpg" }),
    });
    await waitFor(() => expect(result.current.url).toBe("asset:///cache/B.jpg"));

    // A resolves late — the cancelled guard must keep B, not overwrite it with A.
    await act(async () => {
      resolveA("/cache/A.jpg");
      await Promise.resolve();
    });
    expect(result.current.url).toBe("asset:///cache/B.jpg");
  });

  it("surfaces a cloud download error message", async () => {
    state.fileUrl = { isLocal: false, url: "" };
    tauri.onInvoke("cache_remote_file", () => {
      throw "download failed";
    });
    const { result } = renderHook(() =>
      useViewableFileUrl(file({ source: undefined, fileId: "fid", label: "photos" }))
    );

    await waitFor(() => expect(result.current.error).toBe("download failed"));
    expect(result.current.url).toBe("");
  });
});
