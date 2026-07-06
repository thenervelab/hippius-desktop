import { vi } from "vitest";

// Shared mock for the Tauri IPC boundary (`@tauri-apps/api/core` +
// `@tauri-apps/api/event`). Before this helper, ~15 test files hand-rolled the
// same `invoke` stub and `listen` handler Map; five re-implemented the Map by
// hand. Centralizing it makes a new hook/component test cost a few lines.
//
// USAGE — the mock must be installed in a hoist-safe way. Vitest hoists every
// `vi.mock(...)` call above the file's imports, so a normally-imported instance
// would be in the temporal dead zone when a mock factory first runs (the hook
// under test imports `@tauri-apps/api/core` during its own import). `vi.hoisted`
// guarantees the instance exists before any factory runs:
//
//   const tauri = await vi.hoisted(async () => {
//     const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
//     return makeTauriMock();
//   });
//   vi.mock("@tauri-apps/api/core", () => tauri.core);
//   vi.mock("@tauri-apps/api/event", () => tauri.event);
//
//   beforeEach(() => tauri.reset());
//   tauri.onInvoke("get_all_drive_statuses", () => [...]);
//   await tauri.emitEvent("hcfs_drive_removed", { label: "photos" });
//
// IMPORTANT: a `vi.mock` factory must reference the hoisted instance DIRECTLY
// (the `tauri` const above, or `h.tauri.core` if you wrapped it in an object).
// Do NOT reference a SEPARATELY-destructured `const { core } = tauri` inside a
// factory — that binding is in the temporal dead zone when the factory first
// runs at import time ("Cannot access ... before initialization").

type InvokeArgs = Record<string, unknown> | undefined;
type InvokeHandler = (args: InvokeArgs) => unknown;
type EventHandler = (event: { payload: unknown }) => void;

export interface TauriMock {
  /** Module shape for `vi.mock("@tauri-apps/api/core", () => mock.core)`. */
  core: { invoke: ReturnType<typeof vi.fn> };
  /** Module shape for `vi.mock("@tauri-apps/api/event", () => mock.event)`. */
  event: {
    listen: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  };
  /** Route a single command name to a handler (return value resolves `invoke`; throw to reject). */
  onInvoke(command: string, handler: InvokeHandler): void;
  /** Catch-all for commands with no specific `onInvoke` handler. */
  setInvokeFallback(handler: (command: string, args: InvokeArgs) => unknown): void;
  /** Simulate a Rust→FE event by dispatching to every `listen` handler for `name`. */
  emitEvent(name: string, payload: unknown): Promise<void>;
  /** Clear all handlers/listeners and the spies' call records. */
  reset(): void;
}

export function makeTauriMock(): TauriMock {
  const invokeHandlers = new Map<string, InvokeHandler>();
  let fallback: ((command: string, args: InvokeArgs) => unknown) | null = null;
  const listeners = new Map<string, Set<EventHandler>>();

  const invoke = vi.fn(async (command: string, args?: InvokeArgs) => {
    const handler = invokeHandlers.get(command);
    if (handler) return handler(args);
    if (fallback) return fallback(command, args);
    // Fail loud: an unregistered command is almost always a renamed or
    // mistyped IPC name. Surfacing it as a test error beats a silent
    // `undefined` that hides the very regression these tests should catch.
    throw new Error(`tauriMock: no handler registered for invoke("${command}")`);
  });

  const listen = vi.fn(async (name: string, handler: EventHandler) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  });

  // App code calls `emit()` to push events to other windows; tests rarely
  // assert on it, so it is an inert spy by default — assert on `event.emit`
  // directly when a test does care.
  const emit = vi.fn(async () => {});

  const once = vi.fn(async (name: string, handler: EventHandler) => {
    const wrapped: EventHandler = (e) => {
      listeners.get(name)?.delete(wrapped);
      handler(e);
    };
    return listen(name, wrapped);
  });

  return {
    core: { invoke },
    event: { listen, emit, once },
    onInvoke(command, handler) {
      invokeHandlers.set(command, handler);
    },
    setInvokeFallback(handler) {
      fallback = handler;
    },
    async emitEvent(name, payload) {
      const set = listeners.get(name);
      if (!set) return;
      // Snapshot before iterating: a `once` handler (or any unlisten-on-fire
      // handler) mutates `set` mid-dispatch, which would corrupt a live walk.
      for (const handler of [...set]) handler({ payload });
    },
    reset() {
      invokeHandlers.clear();
      fallback = null;
      listeners.clear();
      invoke.mockClear();
      listen.mockClear();
      emit.mockClear();
      once.mockClear();
    },
  };
}
