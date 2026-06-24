import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStagedChanges } from "@/app/lib/hooks/useStagedChanges";
import type { StagedChanges } from "@/app/lib/types/syncTypes";

// Hoist-safe install of the shared Tauri mock (see tauriMock.ts usage doc).
const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);

const changes = { uploads: [], downloads: [], conflicts: [] } as unknown as StagedChanges;

beforeEach(() => tauri.reset());

describe("useStagedChanges", () => {
  it("fetch populates stagedChanges, scoped to the drive label", async () => {
    tauri.onInvoke("stage_changes", () => changes);
    const { result } = renderHook(() => useStagedChanges("photos"));

    let returned: StagedChanges | null = null;
    await act(async () => {
      returned = await result.current.fetchStagedChanges();
    });

    expect(returned).toEqual(changes);
    expect(result.current.stagedChanges).toEqual(changes);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(tauri.core.invoke).toHaveBeenCalledWith("stage_changes", { label: "photos" });
  });

  it("fetch surfaces an error and returns null without clobbering state", async () => {
    tauri.onInvoke("stage_changes", () => {
      throw new Error("engine down");
    });
    const { result } = renderHook(() => useStagedChanges());

    let returned: StagedChanges | null = changes;
    await act(async () => {
      returned = await result.current.fetchStagedChanges();
    });

    expect(returned).toBeNull();
    expect(result.current.error).toBe("engine down");
    expect(result.current.isLoading).toBe(false);
    expect(tauri.core.invoke).toHaveBeenCalledWith("stage_changes", { label: "default" });
  });

  it("sync passes resolutions and clears stagedChanges on success", async () => {
    tauri.onInvoke("stage_changes", () => changes);
    tauri.onInvoke("sync_with_conflict_resolutions", () => undefined);
    const { result } = renderHook(() => useStagedChanges("docs"));

    await act(async () => {
      await result.current.fetchStagedChanges();
    });
    expect(result.current.stagedChanges).toEqual(changes);

    await act(async () => {
      await result.current.syncWithResolutions({ "a.txt": "keep_local" as never });
    });

    expect(result.current.stagedChanges).toBeNull();
    expect(result.current.isSyncing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(tauri.core.invoke).toHaveBeenCalledWith("sync_with_conflict_resolutions", {
      label: "docs",
      resolutions: { "a.txt": "keep_local" },
    });
  });

  it("sync surfaces an error and keeps stagedChanges", async () => {
    tauri.onInvoke("stage_changes", () => changes);
    tauri.onInvoke("sync_with_conflict_resolutions", () => {
      throw new Error("sync failed");
    });
    const { result } = renderHook(() => useStagedChanges());

    await act(async () => {
      await result.current.fetchStagedChanges();
    });
    await act(async () => {
      await result.current.syncWithResolutions({});
    });

    expect(result.current.error).toBe("sync failed");
    expect(result.current.stagedChanges).toEqual(changes);
  });

  it("cancelReview clears state and swallows backend errors", async () => {
    tauri.onInvoke("stage_changes", () => changes);
    tauri.onInvoke("cancel_review", () => {
      throw new Error("ignored");
    });
    const { result } = renderHook(() => useStagedChanges("photos"));

    await act(async () => {
      await result.current.fetchStagedChanges();
    });
    await act(async () => {
      await result.current.cancelReview();
    });

    expect(result.current.stagedChanges).toBeNull();
    expect(result.current.error).toBeNull();
    expect(tauri.core.invoke).toHaveBeenCalledWith("cancel_review", { label: "photos" });
  });
});
