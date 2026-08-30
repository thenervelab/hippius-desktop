import { afterEach, describe, expect, it, vi } from "vitest";
import { fileManagerLabel, isLinuxPlatform, isMacPlatform } from "../isMacPlatform";

afterEach(() => vi.unstubAllGlobals());

const stubNavigator = (platform: string, userAgent: string) =>
  vi.stubGlobal("navigator", { platform, userAgent });

describe("isMacPlatform", () => {
  it("detects macOS from navigator.platform", () => {
    stubNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isMacPlatform()).toBe(true);
  });

  it("detects macOS from the user-agent when platform is empty", () => {
    stubNavigator("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(isMacPlatform()).toBe(true);
  });

  it("returns false on Windows", () => {
    stubNavigator("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isMacPlatform()).toBe(false);
  });

  it("returns false on Linux", () => {
    stubNavigator("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    expect(isMacPlatform()).toBe(false);
  });
});

describe("fileManagerLabel", () => {
  it("names Finder on macOS", () => {
    stubNavigator("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
    expect(fileManagerLabel()).toBe("Finder");
  });

  it("names Explorer on Windows", () => {
    stubNavigator("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(isLinuxPlatform()).toBe(false);
    expect(fileManagerLabel()).toBe("Explorer");
  });

  it("does not say Finder on Linux", () => {
    stubNavigator("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)");
    expect(isLinuxPlatform()).toBe(true);
    expect(fileManagerLabel()).toBe("file manager");
  });
});
