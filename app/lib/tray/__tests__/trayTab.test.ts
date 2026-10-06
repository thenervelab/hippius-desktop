import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTrayTab, saveTrayTab, TRAY_TAB_STORAGE_KEY } from "../trayTab";

describe("the remembered tray tab", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("opens on Captures when nothing was remembered", () => {
    expect(readTrayTab()).toBe("captures");
  });

  it("comes back as it was left", () => {
    saveTrayTab("all");
    expect(window.localStorage.getItem(TRAY_TAB_STORAGE_KEY)).toBe("all");
    expect(readTrayTab()).toBe("all");
    saveTrayTab("captures");
    expect(readTrayTab()).toBe("captures");
  });

  it("ignores a value it does not know", () => {
    window.localStorage.setItem(TRAY_TAB_STORAGE_KEY, "recent");
    expect(readTrayTab()).toBe("captures");
  });

  it("survives a storage that throws, on both read and write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readTrayTab()).toBe("captures");
    expect(() => saveTrayTab("all")).not.toThrow();
  });
});
