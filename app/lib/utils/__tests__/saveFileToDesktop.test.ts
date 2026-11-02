import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { saveFileToDesktop } from "../saveFileToDesktop";

beforeEach(() => {
  invoke.mockReset();
});

describe("saveFileToDesktop", () => {
  it("copies the row's own path and returns Rust's sentence", async () => {
    invoke.mockResolvedValueOnce("Saved to your Desktop as a.png.");
    await expect(saveFileToDesktop({ sourcePath: "/drive/a.png", fileName: "a.png" })).resolves.toBe(
      "Saved to your Desktop as a.png.",
    );
    expect(invoke).toHaveBeenCalledWith("save_file_to_desktop", { path: "/drive/a.png" });
  });

  it("finds the file through its drive when its own path is gone", async () => {
    invoke
      .mockRejectedValueOnce({ kind: "Io", message: "No such file or directory" })
      .mockResolvedValueOnce("/drive/renamed/a.png")
      .mockResolvedValueOnce("Saved to your Desktop as a.png.");
    await expect(
      saveFileToDesktop({ sourcePath: "/gone/a.png", label: "Work", accountId: "5abc", fileName: "a.png" }),
    ).resolves.toBe("Saved to your Desktop as a.png.");
    expect(invoke).toHaveBeenNthCalledWith(2, "resolve_file_path", { accountId: "5abc", label: "Work", fileName: "a.png" });
    expect(invoke).toHaveBeenNthCalledWith(3, "save_file_to_desktop", { path: "/drive/renamed/a.png" });
  });

  it("passes a refusal other than a missing path straight on", async () => {
    const refusal = { kind: "Validation", message: "That location is not in one of this account's synced folders." };
    invoke.mockRejectedValueOnce(refusal);
    await expect(
      saveFileToDesktop({ sourcePath: "/etc/hosts", label: "Work", accountId: "5abc", fileName: "hosts" }),
    ).rejects.toBe(refusal);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("says so when the file is not on this computer at all", async () => {
    await expect(saveFileToDesktop({ fileName: "a.png" })).rejects.toThrow("isn't on this computer");
    expect(invoke).not.toHaveBeenCalled();
  });
});
