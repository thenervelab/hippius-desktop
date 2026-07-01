import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import { useVpn } from "../useVpn";

// ── Tauri mocks (hoist-safe) ────────────────────────────────────────
//
// `invokeMock` is driven per-command by each test; `listenHandlers`
// captures the event callbacks so a test can simulate a Rust emit by
// invoking the handler directly.
const { invokeMock, listenHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenHandlers: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listenHandlers.set(event, handler);
    return Promise.resolve(() => listenHandlers.delete(event));
  }),
}));

/** A promise whose resolution the test controls, to hold an action in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Default bootstrap: a supported, disconnected peer with no open forwards. */
function bootDisconnected() {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "vpn_status") return Promise.resolve({ kind: "disconnected", supported: true });
    if (cmd === "vpn_list_connections") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
}

describe("useVpn", () => {
  beforeEach(() => {
    listenHandlers.clear();
    invokeMock.mockReset();
  });

  it("bootstraps supported + status from vpn_status and rehydrates open forwards", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "vpn_status") return Promise.resolve({ kind: "connected", supported: true });
      if (cmd === "vpn_list_connections")
        return Promise.resolve([
          { address: "100.64.0.5", port: 22, endpoint: { host: "127.0.0.1", port: 5000 } },
        ]);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useVpn());

    await waitFor(() => expect(result.current.supported).toBe(true));
    expect(result.current.view.phase).toBe("connected");
    expect(result.current.endpoints["100.64.0.5:22"]).toEqual({ host: "127.0.0.1", port: 5000 });
  });

  it("treats a failed status bootstrap as unsupported/disconnected (best-effort)", async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error("backend unreachable")));

    const { result } = renderHook(() => useVpn());

    // The empty catch leaves supported=false; the resolver collapses to unsupported.
    await waitFor(() => expect(listenHandlers.has("vpn_status_changed")).toBe(true));
    expect(result.current.supported).toBe(false);
    expect(result.current.view.phase).toBe("unsupported");
  });

  it("a vpn_status_changed event updates the live status", async () => {
    bootDisconnected();
    const { result } = renderHook(() => useVpn());
    await waitFor(() => expect(listenHandlers.has("vpn_status_changed")).toBe(true));

    act(() => listenHandlers.get("vpn_status_changed")!({ payload: { kind: "connected" } }));
    expect(result.current.view.phase).toBe("connected");
  });

  it("openConnection records the endpoint; closeConnection removes it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "vpn_status") return Promise.resolve({ kind: "connected", supported: true });
      if (cmd === "vpn_list_connections") return Promise.resolve([]);
      if (cmd === "vpn_open_vm_connection") return Promise.resolve({ host: "127.0.0.1", port: 6001 });
      if (cmd === "vpn_close_vm_connection") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    const target = { address: "100.64.0.9", port: 22 };

    const { result } = renderHook(() => useVpn());
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => {
      await result.current.openConnection(target);
    });
    expect(result.current.endpoints["100.64.0.9:22"]).toEqual({ host: "127.0.0.1", port: 6001 });

    await act(async () => {
      await result.current.closeConnection(target);
    });
    expect(result.current.endpoints["100.64.0.9:22"]).toBeUndefined();
  });

  it("disconnect clears the endpoint map", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "vpn_status") return Promise.resolve({ kind: "connected", supported: true });
      if (cmd === "vpn_list_connections")
        return Promise.resolve([
          { address: "100.64.0.5", port: 22, endpoint: { host: "127.0.0.1", port: 5000 } },
        ]);
      if (cmd === "vpn_disconnect") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useVpn());
    await waitFor(() => expect(result.current.endpoints["100.64.0.5:22"]).toBeDefined());

    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.endpoints).toEqual({});
  });

  it("busy stays true until ALL overlapping actions settle (in-flight counter)", async () => {
    // The P4 fix: a single boolean let the first action to finish clear busy
    // while another was still running. The counter keeps it set until the last
    // one resolves.
    const connectGate = deferred<void>();
    const openGate = deferred<{ host: string; port: number }>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "vpn_status") return Promise.resolve({ kind: "connected", supported: true });
      if (cmd === "vpn_list_connections") return Promise.resolve([]);
      if (cmd === "vpn_connect") return connectGate.promise;
      if (cmd === "vpn_open_vm_connection") return openGate.promise;
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useVpn());
    await waitFor(() => expect(result.current.supported).toBe(true));

    let connectDone!: Promise<void>;
    let openDone!: Promise<unknown>;
    act(() => {
      connectDone = result.current.connect();
      openDone = result.current.openConnection({ address: "100.64.0.5", port: 22 });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    // First action finishes — busy must remain true because the open is pending.
    await act(async () => {
      connectGate.resolve();
      await connectDone;
    });
    expect(result.current.busy).toBe(true);

    // Last action finishes — now busy clears.
    await act(async () => {
      openGate.resolve({ host: "127.0.0.1", port: 7000 });
      await openDone;
    });
    expect(result.current.busy).toBe(false);
  });
});
