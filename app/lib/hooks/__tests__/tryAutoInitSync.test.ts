// Retry-ladder semantics of `tryAutoInitSync` (PR #124 review P2-1).
//
// Rust's AutoInitGuard answers a CONCURRENT auto-init with
// `{ anyInitialized: false, skippedReason: "Auto-init already in progress" }`.
// The ladder used to return that as terminal `false` — so when the in-flight
// run was the Rust-side post-unlock spawn, and this chain's preceding
// `stop_sync` had superseded some of its drive inits, nothing ever retried
// and the drives stayed silently uninitialized until the next launch. The
// busy skip must be retryable; the other skip reasons stay terminal.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeWithTimeoutMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/utils/invokeWithTimeout", () => ({
  invokeWithTimeout: invokeWithTimeoutMock,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { tryAutoInitSync } from "@/app/lib/hooks/useHcfsSync";

function autoInitResult(overrides: Partial<{
  anyInitialized: boolean;
  isConfigured: boolean;
  skippedReason: string | null;
}> = {}) {
  return {
    anyInitialized: false,
    isConfigured: true,
    skippedReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("tryAutoInitSync", () => {
  it("retries a busy-guard skip and returns the follow-up attempt's result", async () => {
    invokeWithTimeoutMock
      .mockResolvedValueOnce(
        autoInitResult({ skippedReason: "Auto-init already in progress" })
      )
      .mockResolvedValueOnce(autoInitResult({ anyInitialized: true }));

    const result = await tryAutoInitSync("5TestAccount");

    expect(result).toBe(true);
    expect(invokeWithTimeoutMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("treats other skip reasons as terminal (no retry)", async () => {
    invokeWithTimeoutMock.mockResolvedValue(
      autoInitResult({ isConfigured: false, skippedReason: "No sync paths configured" })
    );

    const result = await tryAutoInitSync("5TestAccount");

    expect(result).toBe(false);
    expect(invokeWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("a straightforward success needs one attempt", async () => {
    invokeWithTimeoutMock.mockResolvedValue(autoInitResult({ anyInitialized: true }));

    const result = await tryAutoInitSync("5TestAccount");

    expect(result).toBe(true);
    expect(invokeWithTimeoutMock).toHaveBeenCalledTimes(1);
  });
});
