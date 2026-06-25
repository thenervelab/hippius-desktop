import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useInvokeMutation } from "@/app/lib/hooks/api/useInvokeMutation";

const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return { tauri: makeTauriMock(), state: { polkadotAddress: null as string | null } };
});
// vi.mock is hoisted above any destructuring, so the factories reference the
// hoisted `h` directly (a destructured const would be in the TDZ here).
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
// useInvokeMutation imports from "@/lib/wallet-auth-context"; alias-resolves to
// the same file as "@/app/lib/...". Mock the specifier this hook uses.
vi.mock("@/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: h.state.polkadotAddress }),
}));

const { tauri, state } = h;

// Return both the wrapper and the client so a test can spy on invalidateQueries.
function makeHarness() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => {
  tauri.reset();
  state.polkadotAddress = null;
});

describe("useInvokeMutation", () => {
  it("rejects the mutation when there is no wallet address", async () => {
    const { wrapper } = makeHarness();
    const { result } = renderHook(
      () => useInvokeMutation({ command: "do_x" }),
      { wrapper }
    );

    await expect(result.current.mutateAsync()).rejects.toThrow(
      "No wallet address available"
    );
    expect(tauri.core.invoke).not.toHaveBeenCalled();
  });

  it("invokes with default { accountId } params", async () => {
    state.polkadotAddress = "5auth";
    tauri.onInvoke("do_x", () => ({ ok: true }));
    const { wrapper } = makeHarness();
    const { result } = renderHook(
      () => useInvokeMutation<{ ok: boolean }, void>({ command: "do_x" }),
      { wrapper }
    );

    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(tauri.core.invoke).toHaveBeenCalledWith("do_x", { accountId: "5auth" });
  });

  it("builds custom params from (address, variables)", async () => {
    state.polkadotAddress = "5auth";
    tauri.onInvoke("transfer", () => ({}));
    const { wrapper } = makeHarness();
    const { result } = renderHook(
      () =>
        useInvokeMutation<unknown, { to: string; amount: number }>({
          command: "transfer",
          params: (addr, vars) => ({ from: addr, ...vars }),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.mutateAsync({ to: "5dest", amount: 10 });
    });
    expect(tauri.core.invoke).toHaveBeenCalledWith("transfer", {
      from: "5auth",
      to: "5dest",
      amount: 10,
    });
  });

  it("invalidates the configured keys and then runs the user onSuccess", async () => {
    state.polkadotAddress = "5auth";
    tauri.onInvoke("do_x", () => ({ ok: true }));
    const { client, wrapper } = makeHarness();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const userOnSuccess = vi.fn();

    const { result } = renderHook(
      () =>
        useInvokeMutation(
          { command: "do_x", invalidateKeys: [["balance"], ["credits"]] },
          { onSuccess: userOnSuccess }
        ),
      { wrapper }
    );

    await act(async () => {
      // No variables for this command; pass undefined explicitly because the
      // userOnSuccess inference site widens TVariables off `void`.
      await result.current.mutateAsync(undefined);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["balance"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["credits"] });
    expect(userOnSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not invalidate when the mutation fails", async () => {
    state.polkadotAddress = "5auth";
    tauri.onInvoke("do_x", () => {
      throw new Error("boom");
    });
    const { client, wrapper } = makeHarness();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(
      () => useInvokeMutation({ command: "do_x", invalidateKeys: [["balance"]] }),
      { wrapper }
    );

    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
