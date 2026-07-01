import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTauriMock } from "@/app/lib/test-utils/tauriMock";

// ── Part 1: the routing/dispatch logic, exercised directly ──────────────────
describe("makeTauriMock — logic", () => {
  it("routes invoke to the registered command handler and resolves its return", async () => {
    const tauri = makeTauriMock();
    tauri.onInvoke("get_thing", (args) => ({ echoed: args }));

    await expect(tauri.core.invoke("get_thing", { id: 1 })).resolves.toEqual({
      echoed: { id: 1 },
    });
  });

  it("rejects loudly for an unregistered command (renamed/typo'd IPC name)", async () => {
    const tauri = makeTauriMock();
    await expect(tauri.core.invoke("nope")).rejects.toThrow(
      'tauriMock: no handler registered for invoke("nope")'
    );
  });

  it("propagates a thrown handler as a rejected promise (error-path tests)", async () => {
    const tauri = makeTauriMock();
    tauri.onInvoke("get_thing", () => {
      throw new Error("backend unreachable");
    });
    await expect(tauri.core.invoke("get_thing")).rejects.toThrow(
      "backend unreachable"
    );
  });

  it("uses the fallback only when no specific handler matches", async () => {
    const tauri = makeTauriMock();
    tauri.onInvoke("specific", () => "specific-result");
    tauri.setInvokeFallback((command) => `fallback:${command}`);

    await expect(tauri.core.invoke("specific")).resolves.toBe("specific-result");
    await expect(tauri.core.invoke("other")).resolves.toBe("fallback:other");
  });

  it("dispatches emitEvent to every listener registered for that name", async () => {
    const tauri = makeTauriMock();
    const a = vi.fn();
    const b = vi.fn();
    await tauri.event.listen("evt", a);
    await tauri.event.listen("evt", b);

    await tauri.emitEvent("evt", { n: 7 });

    expect(a).toHaveBeenCalledWith({ payload: { n: 7 } });
    expect(b).toHaveBeenCalledWith({ payload: { n: 7 } });
  });

  it("stops delivering to a handler after its unlisten runs", async () => {
    const tauri = makeTauriMock();
    const handler = vi.fn();
    const unlisten = await tauri.event.listen("evt", handler);

    await tauri.emitEvent("evt", 1);
    unlisten();
    await tauri.emitEvent("evt", 2);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("once delivers exactly one event then auto-removes", async () => {
    const tauri = makeTauriMock();
    const handler = vi.fn();
    await tauri.event.once("evt", handler);

    await tauri.emitEvent("evt", "first");
    await tauri.emitEvent("evt", "second");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ payload: "first" });
  });

  it("emitEvent for an unknown name is a no-op (no throw)", async () => {
    const tauri = makeTauriMock();
    await expect(tauri.emitEvent("never-listened", 1)).resolves.toBeUndefined();
  });

  it("reset clears handlers, listeners, and spy call records", async () => {
    const tauri = makeTauriMock();
    tauri.onInvoke("cmd", () => "ok");
    const handler = vi.fn();
    await tauri.event.listen("evt", handler);
    await tauri.core.invoke("cmd");

    tauri.reset();

    expect(tauri.core.invoke).not.toHaveBeenCalled();
    await tauri.emitEvent("evt", 1);
    expect(handler).not.toHaveBeenCalled();
    await expect(tauri.core.invoke("cmd")).rejects.toThrow(/no handler/);
  });
});

// ── Part 2: the hoist-safe `vi.mock` boundary usage (the documented pattern) ─
//
// This proves the README usage block works end-to-end: a consumer importing
// from the REAL module paths receives the mock, with no temporal-dead-zone
// error from Vitest's mock hoisting.
const tauri = await vi.hoisted(async () => {
  const { makeTauriMock: make } = await import("@/app/lib/test-utils/tauriMock");
  return make();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

describe("makeTauriMock — hoist-safe vi.mock boundary", () => {
  beforeEach(() => tauri.reset());

  it("a module importing @tauri-apps/api/core gets the mocked invoke", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    tauri.onInvoke("ping", () => "pong");
    await expect(invoke("ping")).resolves.toBe("pong");
  });

  it("a module importing @tauri-apps/api/event receives emitted events", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const handler = vi.fn();
    await listen("hcfs_drive_removed", handler);

    await tauri.emitEvent("hcfs_drive_removed", { label: "photos" });

    expect(handler).toHaveBeenCalledWith({ payload: { label: "photos" } });
  });
});
