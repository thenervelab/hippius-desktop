import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { revealFile } from "../revealFile";

beforeEach(() => {
  invoke.mockReset();
});

describe("revealFile", () => {
  it("falls through to the DB path on an Io rejection", async () => {
    invoke
      .mockRejectedValueOnce({
        kind: "Io",
        message: "I/O error: No such file or directory (os error 2)",
      })
      .mockResolvedValueOnce("/resolved/path.txt")
      .mockResolvedValueOnce(undefined);

    await revealFile({
      sourcePath: "/gone.txt",
      label: "docs",
      accountId: "5abc",
      fileName: "gone.txt",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "reveal_path_in_file_manager", {
      path: "/gone.txt",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "resolve_file_path", {
      accountId: "5abc",
      label: "docs",
      fileName: "gone.txt",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "reveal_path_in_file_manager", {
      path: "/resolved/path.txt",
    });
  });

  it("does not treat xdg-open-not-found as a missing path", async () => {
    const err = {
      kind: "Other",
      message: "Couldn't open the file manager (xdg-open was not found).",
    };
    invoke.mockRejectedValueOnce(err);

    await expect(
      revealFile({
        sourcePath: "/present.txt",
        label: "docs",
        accountId: "5abc",
        fileName: "present.txt",
      }),
    ).rejects.toEqual(err);

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
