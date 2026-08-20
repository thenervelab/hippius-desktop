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

    let outcome: Awaited<ReturnType<typeof result.current.syncWithResolutions>> | null = null;
    await act(async () => {
      outcome = await result.current.syncWithResolutions({ "a.txt": "keep_local" as never });
    });

    expect(outcome).toEqual({ ok: true });
    expect(result.current.stagedChanges).toBeNull();
    expect(result.current.isSyncing).toBe(false);
    expect(result.current.error).toBeNull();
    expect(tauri.core.invoke).toHaveBeenCalledWith("sync_with_conflict_resolutions", {
      label: "docs",
      resolutions: { "a.txt": "keep_local" },
    });
  });

  it("sync surfaces an error result and keeps stagedChanges", async () => {
    tauri.onInvoke("stage_changes", () => changes);
    tauri.onInvoke("sync_with_conflict_resolutions", () => {
      throw new Error("sync failed");
    });
    const { result } = renderHook(() => useStagedChanges());

    await act(async () => {
      await result.current.fetchStagedChanges();
    });
    let outcome: Awaited<ReturnType<typeof result.current.syncWithResolutions>> | null = null;
    await act(async () => {
      outcome = await result.current.syncWithResolutions({});
    });

    // The caller must be able to tell failure from success — a failed resolve
    // used to look identical to a successful one and closed the dialog silently.
    expect(outcome).toEqual({ ok: false, message: "sync failed", syncInProgress: false });
    expect(result.current.error).toBe("sync failed");
    expect(result.current.stagedChanges).toEqual(changes);
  });

  it("sync classifies NotReady(SyncInProgress) so callers can say 'retry shortly'", async () => {
    tauri.onInvoke("stage_changes", () => changes);
    // The exact wire shape Rust serializes for AppError::NotReady(SyncInProgress)
    // (see src-tauri/src/error.rs::AppError::serialize) — invoke() rejects with
    // this plain object, NOT an Error instance.
    tauri.onInvoke("sync_with_conflict_resolutions", () => {
      throw {
        kind: "NotReady",
        subkind: "SYNC_IN_PROGRESS",
        message: "Sync is in progress, please wait",
      };
    });
    const { result } = renderHook(() => useStagedChanges());

    await act(async () => {
      await result.current.fetchStagedChanges();
    });
    let outcome: Awaited<ReturnType<typeof result.current.syncWithResolutions>> | null = null;
    await act(async () => {
      outcome = await result.current.syncWithResolutions({});
    });

    expect(outcome).toEqual({
      ok: false,
      message: "Sync is in progress, please wait",
      syncInProgress: true,
    });
    // The staged changes (and thus the dialog's conflict list) must survive
    // so the user's chosen resolutions are still there on retry.
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
