import { describe, it, expect, vi } from "vitest";

// `planThumbnail` → `getFileUrl` → `convertFileSrc`; stub it so a local source
// yields a predictable asset URL without the Tauri runtime.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
  invoke: vi.fn(),
}));

import { planThumbnail } from "../useThumbnail";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const file = (over: Partial<FormattedUserFile>): FormattedUserFile =>
  ({ name: "f", ...over }) as FormattedUserFile;

describe("planThumbnail", () => {
  it("serves a synced on-disk file from the local fast path", () => {
    const plan = planThumbnail(
      file({ source: "/Users/me/Hippius/pic.png", syncStatus: "synced" }),
      "5Addr",
    );
    expect(plan).toEqual({ kind: "local", url: "asset://localhost//Users/me/Hippius/pic.png" });
  });

  it("routes a cloud-only file (no local copy) to the Rust thumbnailer", () => {
    const plan = planThumbnail(
      file({ fileId: "deadbeef", label: "Drive", arionHash: "hash1" }),
      "5Addr",
    );
    expect(plan).toEqual({
      kind: "cloud",
      accountId: "5Addr",
      label: "Drive",
      fileId: "deadbeef",
      arionHash: "hash1",
      source: null,
    });
  });

  it("treats a `pending` hit as cloud even though it carries a would-be local path", () => {
    // The bytes aren't on disk yet; the server `fileId` marks it cloud-bound.
    const plan = planThumbnail(
      file({ source: "/Users/me/Hippius/p.jpg", syncStatus: "pending", fileId: "id1", label: "Drive" }),
      "5Addr",
    );
    expect(plan.kind).toBe("cloud");
  });

  it("gives up (icon fallback) when a cloud file lacks the server id", () => {
    expect(planThumbnail(file({ label: "Drive" }), "5Addr")).toEqual({ kind: "none" });
  });

  it("gives up when there is no signed-in account to fetch under", () => {
    expect(planThumbnail(file({ fileId: "id", label: "Drive" }), null)).toEqual({ kind: "none" });
  });
});
