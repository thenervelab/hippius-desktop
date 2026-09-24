// The Share dev tools settings: never on outside dev and staging builds,
// every stored field clamped, the older single-number key still honoured,
// and the presets switching fake data on with the counts they name.

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  PRESETS,
  SHARE_DEVTOOLS_EVENT,
  SHARE_DEVTOOLS_KEY,
  SHARE_FIXTURE_AVAILABLE,
  SHARE_FIXTURE_KEY,
  activeShareDevSettings,
  applyPreset,
  normalizeSettings,
  readShareDevSettings,
  resetShareDevSettings,
  settingsFromLegacy,
  writeShareDevSettings,
} from "../shareDevToolsSettings";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const ON = JSON.stringify({ ...DEFAULT_SETTINGS, enabled: true, people: 60 });

describe("the build gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@/app/lib/buildChannel");
    vi.resetModules();
  });

  async function availableOn(channel: "production" | "beta" | "staging", nodeEnv: string) {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.doMock("@/app/lib/buildChannel", () => ({
      enabledFrom: (minimum: string) => minimum === "staging" && channel === "staging",
    }));
    return (await import("../shareDevToolsSettings")).SHARE_FIXTURE_AVAILABLE;
  }

  it("is never available on a beta or production build", async () => {
    expect(await availableOn("production", "production")).toBe(false);
    expect(await availableOn("beta", "production")).toBe(false);
  });

  it("is available on staging and in development", async () => {
    expect(await availableOn("staging", "production")).toBe(true);
    expect(await availableOn("production", "development")).toBe(true);
  });

  it("is off in the test build, which stands in for production", () => {
    expect(SHARE_FIXTURE_AVAILABLE).toBe(false);
  });

  it("ignores stored settings where the build does not allow them", () => {
    const storage = memoryStorage({ [SHARE_DEVTOOLS_KEY]: ON, [SHARE_FIXTURE_KEY]: "12" });
    expect(activeShareDevSettings(false, storage)).toBeNull();
    expect(readShareDevSettings(false, storage)).toEqual(DEFAULT_SETTINGS);
    writeShareDevSettings({ ...DEFAULT_SETTINGS, enabled: true, people: 3 }, false, storage);
    expect(storage.data.get(SHARE_DEVTOOLS_KEY)).toBe(ON);
  });
});

describe("reading and writing", () => {
  it("is off until something is stored", () => {
    expect(activeShareDevSettings(true, memoryStorage())).toBeNull();
    expect(activeShareDevSettings(true, null)).toBeNull();
  });

  it("reads what the panel stored", () => {
    const storage = memoryStorage();
    writeShareDevSettings({ ...DEFAULT_SETTINGS, enabled: true, people: 60, latencyMs: 3000 }, true, storage);
    expect(activeShareDevSettings(true, storage)).toMatchObject({ enabled: true, people: 60, latencyMs: 3000 });
  });

  it("tells open surfaces after a write and a reset", () => {
    const heard = vi.fn();
    window.addEventListener(SHARE_DEVTOOLS_EVENT, heard);
    try {
      const storage = memoryStorage();
      writeShareDevSettings({ ...DEFAULT_SETTINGS, enabled: true }, true, storage);
      resetShareDevSettings(true, storage);
      expect(heard).toHaveBeenCalledTimes(2);
      expect(storage.data.size).toBe(0);
    } finally {
      window.removeEventListener(SHARE_DEVTOOLS_EVENT, heard);
    }
  });

  it("treats blocked or corrupt storage as off", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(activeShareDevSettings(true, blocked)).toBeNull();
    expect(() => writeShareDevSettings(DEFAULT_SETTINGS, true, blocked)).not.toThrow();
    expect(activeShareDevSettings(true, memoryStorage({ [SHARE_DEVTOOLS_KEY]: "{not json" }))).toBeNull();
  });

  it("clamps every count and snaps the steps", () => {
    const s = normalizeSettings({
      enabled: true,
      people: 500,
      pending: -3,
      activeLinks: "40",
      endedLinks: 51,
      latencyMs: 999,
      failureRate: 33,
      loading: "yes",
    });
    expect(s).toMatchObject({
      people: 100,
      pending: 0,
      activeLinks: 40,
      endedLinks: 50,
      latencyMs: 0,
      failureRate: 33,
      loading: false,
    });
  });
});

describe("the older key", () => {
  it("maps a number to People and keeps the locked word", () => {
    expect(settingsFromLegacy("12")).toMatchObject({ enabled: true, people: 12, linksLocked: false });
    expect(settingsFromLegacy("12 locked")).toMatchObject({ enabled: true, people: 12, linksLocked: true });
    expect(settingsFromLegacy("250")?.people).toBe(100);
    expect(settingsFromLegacy("abc")).toBeNull();
    expect(settingsFromLegacy("")).toBeNull();
    expect(settingsFromLegacy(null)).toBeNull();
  });

  it("is read when the new key is absent, and loses to it when present", () => {
    expect(activeShareDevSettings(true, memoryStorage({ [SHARE_FIXTURE_KEY]: "7" }))?.people).toBe(7);
    expect(
      activeShareDevSettings(true, memoryStorage({ [SHARE_FIXTURE_KEY]: "7", [SHARE_DEVTOOLS_KEY]: ON }))?.people,
    ).toBe(60);
  });
});

describe("presets", () => {
  it("name the counts they set", () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.id, p.counts]));
    expect(by.empty).toEqual({ people: 0, pending: 0, activeLinks: 0, endedLinks: 0 });
    expect(by.small.people).toBe(5);
    expect(by.big).toMatchObject({ people: 60, activeLinks: 45, endedLinks: 15 });
    expect(by.huge).toMatchObject({ people: 100, activeLinks: 100, endedLinks: 50 });
  });

  it("switch fake data on and release the Loading and Error holds", () => {
    const s = applyPreset({ ...DEFAULT_SETTINGS, loading: true, error: true, latencyMs: 3000 }, "big");
    expect(s).toMatchObject({ enabled: true, loading: false, error: false, latencyMs: 3000, people: 60 });
  });
});
