import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { resolveHostedBy } from "@/app/lib/utils/syncPathUtils";

describe("resolveHostedBy", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("asks Rust with the picked path and returns the host it names", async () => {
    const host = { kind: "fileProvider" as const, name: "Google Drive" };
    invoke.mockResolvedValueOnce(host);
    await expect(resolveHostedBy("/Users/me/Library/CloudStorage/GoogleDrive-x/Work")).resolves.toEqual(
      host
    );
    expect(invoke).toHaveBeenCalledWith("sync_root_host", {
      path: "/Users/me/Library/CloudStorage/GoogleDrive-x/Work",
    });
  });

  it("reads an ordinary folder as not hosted", async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(resolveHostedBy("/Users/me/Hippius")).resolves.toBeNull();
  });

  it("reads a failed call as not hosted rather than blocking the add", async () => {
    invoke.mockRejectedValueOnce(new Error("no such command"));
    await expect(resolveHostedBy("/Users/me/Hippius")).resolves.toBeNull();
  });
});
