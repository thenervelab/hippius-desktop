// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/api/path
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(),
  dirname: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { homeDir, dirname } from "@tauri-apps/api/path";
import {
  getLastBrowseDirectory,
  saveLastBrowseDirectory,
} from "../userPreferencesDb";

const mockInvoke = vi.mocked(invoke);
const mockHomeDir = vi.mocked(homeDir);
const mockDirname = vi.mocked(dirname);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getLastBrowseDirectory", () => {
  it("returns saved directory when preference exists", async () => {
    mockInvoke.mockResolvedValue('"/Users/ahmad/Documents"');

    const result = await getLastBrowseDirectory();
    expect(result).toBe("/Users/ahmad/Documents");
    expect(mockInvoke).toHaveBeenCalledWith("get_user_preference", {
      key: "last_browse_directory",
    });
  });

  it("falls back to homeDir when no preference saved", async () => {
    mockInvoke.mockResolvedValue(null);
    mockHomeDir.mockResolvedValue("/Users/ahmad");

    const result = await getLastBrowseDirectory();
    expect(result).toBe("/Users/ahmad");
  });

  it("returns undefined when both preference and homeDir fail", async () => {
    mockInvoke.mockResolvedValue(null);
    mockHomeDir.mockRejectedValue(new Error("not available"));

    const result = await getLastBrowseDirectory();
    expect(result).toBeUndefined();
  });

  it("falls back to homeDir when preference lookup throws", async () => {
    mockInvoke.mockRejectedValue(new Error("DB error"));
    mockHomeDir.mockResolvedValue("/Users/ahmad");

    const result = await getLastBrowseDirectory();
    expect(result).toBe("/Users/ahmad");
  });
});

describe("saveLastBrowseDirectory", () => {
  it("saves folder path directly", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await saveLastBrowseDirectory("/Users/ahmad/Pictures");

    expect(mockInvoke).toHaveBeenCalledWith("save_user_preference", {
      key: "last_browse_directory",
      value: '"/Users/ahmad/Pictures"',
    });
  });

  it("extracts parent directory for file paths", async () => {
    mockDirname.mockResolvedValue("/Users/ahmad/Documents");
    mockInvoke.mockResolvedValue(undefined);

    await saveLastBrowseDirectory("/Users/ahmad/Documents/report.pdf", true);

    expect(mockDirname).toHaveBeenCalledWith(
      "/Users/ahmad/Documents/report.pdf"
    );
    expect(mockInvoke).toHaveBeenCalledWith("save_user_preference", {
      key: "last_browse_directory",
      value: '"/Users/ahmad/Documents"',
    });
  });

  it("does not throw when save fails", async () => {
    mockInvoke.mockRejectedValue(new Error("DB error"));

    // Should not throw
    await expect(
      saveLastBrowseDirectory("/Users/ahmad/Documents")
    ).resolves.toBeUndefined();
  });
});
