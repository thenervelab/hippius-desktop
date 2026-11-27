import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, Record<string, unknown>]>,
  skip: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    h.calls.push([cmd, args]);
    if (cmd === "get_trash_delete_rules") {
      return Promise.resolve({ skipTrash: h.skip, drives: [{ label: "docs", canDeleteForever: true, skipsTrash: h.skip }] });
    }
    if (cmd === "set_skip_trash") {
      h.skip = args.skip as boolean;
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  }),
}));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import SkipTrashSetting from "../SkipTrashSetting";

function renderSetting(trash: boolean) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { drive_trash: trash } as never);
  return render(
    <Provider store={store}>
      <SkipTrashSetting />
    </Provider>,
  );
}

beforeEach(() => {
  h.calls.length = 0;
  h.skip = false;
});

describe("Skip Trash when deleting", () => {
  it("shows nothing and asks Rust nothing while the server has no Trash", () => {
    const { container } = renderSetting(false);
    expect(container).toBeEmptyDOMElement();
    expect(h.calls).toEqual([]);
  });

  it("reads the setting from Rust and saves it there, which applies it to the drives' sync", async () => {
    renderSetting(true);
    const toggle = await screen.findByRole("switch", { name: "Skip Trash when deleting" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    await waitFor(() => expect(h.calls.some(([cmd]) => cmd === "set_skip_trash")).toBe(true));
    expect(h.calls.find(([cmd]) => cmd === "set_skip_trash")![1]).toEqual({ accountId: "5Me", skip: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(h.calls.filter(([cmd]) => cmd === "get_trash_delete_rules").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/your own drives/)).toBeInTheDocument();
  });
});
