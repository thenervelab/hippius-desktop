import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInvokeQuery } from "@/app/lib/hooks/api/useInvokeQuery";

// Shared mock + a mutable wallet-state holder, both hoisted so the vi.mock
// factories (which run before imports) can close over them.
const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return {
    tauri: makeTauriMock(),
    state: {
      polkadotAddress: null as string | null,
      activeWallet: null as { address: string } | null,
    },
  };
});
// vi.mock is hoisted above any destructuring, so the factories must reference
// the hoisted `h` directly (a destructured `tauri`/`state` would be in the TDZ
// when a factory first runs at import time).
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: h.state.polkadotAddress }),
}));
vi.mock("@/app/contexts/LocalWalletContext", () => ({
  useLocalWallet: () => ({ activeWallet: h.state.activeWallet }),
}));

const { tauri, state } = h;

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "TestQueryWrapper";
  return Wrapper;
}

beforeEach(() => {
  tauri.reset();
  state.polkadotAddress = null;
  state.activeWallet = null;
});

describe("useInvokeQuery", () => {
  it("stays disabled and never invokes when there is no address", async () => {
    const { result } = renderHook(
      () => useInvokeQuery({ command: "get_x", queryKey: ["x"] }),
      { wrapper: makeWrapper() }
    );
    // A disabled query sits idle.
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("invokes with the auth address and default params", async () => {
    state.polkadotAddress = "5auth";
    tauri.onInvoke("get_x", () => ({ value: 1 }));
    const { result } = renderHook(
      () => useInvokeQuery({ command: "get_x", queryKey: ["x"] }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ value: 1 });
    expect(tauri.core.invoke).toHaveBeenCalledWith("get_x", { accountId: "5auth" });
  });

  it("uses the active wallet address when addressSource is activeWallet", async () => {
    state.polkadotAddress = "5auth";
    state.activeWallet = { address: "5active" };
    tauri.onInvoke("get_x", () => ({ ok: true }));
    const { result } = renderHook(
      () =>
        useInvokeQuery({
          command: "get_x",
          queryKey: (addr) => ["x", addr],
          addressSource: "activeWallet",
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tauri.core.invoke).toHaveBeenCalledWith("get_x", { accountId: "5active" });
  });

  it("falls back to the auth address while the local wallet is still hydrating", async () => {
    state.polkadotAddress = "5auth";
    state.activeWallet = null; // not hydrated yet
    tauri.onInvoke("get_x", () => ({}));
    const { result } = renderHook(
      () =>
        useInvokeQuery({
          command: "get_x",
          queryKey: (addr) => ["x", addr],
          addressSource: "activeWallet",
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tauri.core.invoke).toHaveBeenCalledWith("get_x", { accountId: "5auth" });
  });

  it("refetches under the new address when the active wallet switches", async () => {
    state.polkadotAddress = "5auth";
    state.activeWallet = { address: "5walletA" };
    tauri.onInvoke("get_x", (args) => ({ who: (args as { accountId: string }).accountId }));
    const { result, rerender } = renderHook(
      () =>
        useInvokeQuery({
          command: "get_x",
          queryKey: (addr) => ["x", addr], // address in the key → cache scoped per wallet
          addressSource: "activeWallet",
        }),
      { wrapper: makeWrapper() }
    );

    await waitFor(() => expect(result.current.data).toEqual({ who: "5walletA" }));

    // User picks a different wallet in the header.
    state.activeWallet = { address: "5walletB" };
    rerender();

    await waitFor(() => expect(result.current.data).toEqual({ who: "5walletB" }));
    expect(tauri.core.invoke).toHaveBeenCalledWith("get_x", { accountId: "5walletB" });
  });

  it("stays disabled when the params builder returns null", async () => {
    state.polkadotAddress = "5auth";
    const { result } = renderHook(
      () => useInvokeQuery({ command: "get_x", queryKey: ["x"], params: () => null }),
      { wrapper: makeWrapper() }
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("passes a custom params object through to invoke", async () => {
    state.polkadotAddress = "5auth";
    tauri.onInvoke("get_x", () => ({}));
    const { result } = renderHook(
      () =>
        useInvokeQuery({
          command: "get_x",
          queryKey: ["x"],
          params: (addr) => ({ owner: addr, page: 1 }),
        }),
      { wrapper: makeWrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(tauri.core.invoke).toHaveBeenCalledWith("get_x", { owner: "5auth", page: 1 });
  });
});
