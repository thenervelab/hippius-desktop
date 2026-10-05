// The large-delete prompt: every button path, every refusal kind Rust can
// answer with, the member case, and "Decide later". Only the IPC boundary
// and the toasts are mocked; the atom, the reducer and the copy are real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return {
    tauri: makeTauriMock(),
    toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
  };
});
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/lib/capture/shortcutLabel", () => ({ isMacPlatform: () => true }));
const { tauri, toast } = h;

import MassDeleteBanner from "../MassDeleteBanner";
import { massDeleteHoldsAtom } from "@/app/lib/store/syncAtoms";
import { applyHeld, holdKey } from "@/app/lib/massDelete/holds";
import type { MassDeleteHold } from "@/app/lib/tauri/massDelete";

const SERVER: MassDeleteHold = {
  label: "Photos",
  side: "server",
  state: "held",
  count: 150,
  syncedCount: 200,
  emptyRoot: false,
  canRestore: true,
};

const notReady = (subkind: string, extra: Record<string, unknown> = {}) => ({
  kind: "NotReady",
  subkind,
  message: "words the prompt must not parse",
  ...extra,
});

beforeEach(() => {
  tauri.reset();
  vi.clearAllMocks();
});

function renderBanner(...holds: MassDeleteHold[]) {
  const store = createStore();
  store.set(
    massDeleteHoldsAtom,
    holds.reduce((map, hold) => applyHeld(map, hold), new Map()),
  );
  render(
    <Provider store={store}>
      <MassDeleteBanner />
    </Provider>,
  );
  return store;
}

const restoreButton = () => screen.queryByRole("button", { name: "Restore files" });

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("MassDeleteBanner", () => {
  it("renders nothing without a hold", () => {
    renderBanner();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("announces a server-side hold with its counts, Restore first", () => {
    renderBanner({ ...SERVER, emptyRoot: true });
    const banner = screen.getByRole("region");
    expect(banner).toHaveAccessibleName("150 of 200 files in “Photos” are missing from this Mac");
    expect(within(banner).getByText("Nothing has been deleted from Hippius yet.")).toBeInTheDocument();
    expect(within(banner).getByText(/reconnect it/)).toBeInTheDocument();

    const buttons = within(banner).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Restore files", "Remove from Hippius", "Decide later"]);
  });

  it("Restore sends the shown count and shows progress", async () => {
    tauri.onInvoke("restore_mass_delete", () => undefined);
    renderBanner(SERVER);
    await click("Restore files");

    expect(tauri.core.invoke).toHaveBeenCalledWith("restore_mass_delete", {
      label: "Photos",
      side: "server",
      count: 150,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Restoring 150 files…");
    expect(restoreButton()).toBeNull();
  });

  it("Remove asks again with the count, and only the confirm button removes", async () => {
    tauri.onInvoke("confirm_mass_delete", () => undefined);
    renderBanner(SERVER);

    await click("Remove from Hippius");
    expect(await screen.findByText("Remove 150 files from Hippius?")).toBeInTheDocument();
    await click("Keep files");
    expect(tauri.core.invoke).not.toHaveBeenCalled();

    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByText("Remove 150 files from Hippius?")).toBeNull());
    expect(tauri.core.invoke).not.toHaveBeenCalled();

    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await click("Remove 150 files");
    expect(tauri.core.invoke).toHaveBeenCalledWith("confirm_mass_delete", {
      label: "Photos",
      side: "server",
      count: 150,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Removing 150 files…");
  });

  // The confirmation is the user agreeing to one number. A hold that grows
  // while it is open must not change what they agreed to: the dialog keeps
  // and sends the count it opened with, and Rust refuses it as changed.
  it("Remove sends the count the confirmation opened with, not a newer one", async () => {
    tauri.onInvoke("confirm_mass_delete", () => {
      throw notReady("MASS_DELETE_HOLD_CHANGED", { held: 180 });
    });
    const store = renderBanner(SERVER);
    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");

    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, { ...SERVER, count: 180 }));
    });
    expect(screen.getByText("Remove 150 files from Hippius?")).toBeInTheDocument();
    await click("Remove 150 files");

    expect(tauri.core.invoke).toHaveBeenCalledWith("confirm_mass_delete", {
      label: "Photos",
      side: "server",
      count: 150,
    });
    expect(screen.getByText(/changed to 180\. Check it and choose again\./)).toBeInTheDocument();
  });

  it("Decide later hides the banner until the hold next changes", async () => {
    const store = renderBanner(SERVER);
    await click("Decide later");
    expect(screen.queryByRole("region")).toBeNull();

    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, { ...SERVER, count: 160 }));
    });
    expect(screen.getByRole("region")).toHaveAccessibleName(/160 of 200 files/);
  });

  it("a changed hold shows the new count and asks again", async () => {
    tauri.onInvoke("confirm_mass_delete", () => {
      throw notReady("MASS_DELETE_HOLD_CHANGED", { held: 180 });
    });
    renderBanner(SERVER);
    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await click("Remove 150 files");

    expect(screen.getByRole("region")).toHaveAccessibleName(/180 of 200 files/);
    expect(screen.getByText(/changed to 180\. Check it and choose again\./)).toBeInTheDocument();
    expect(restoreButton()).toBeInTheDocument();
  });

  it("nothing held refreshes the holds", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_NOTHING_HELD");
    });
    tauri.onInvoke("get_mass_delete_holds", () => []);
    renderBanner(SERVER);
    await click("Restore files");

    expect(toast.info).toHaveBeenCalledWith("These files are no longer waiting for a decision.");
    expect(tauri.core.invoke).toHaveBeenCalledWith("get_mass_delete_holds");
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
  });

  it("a restore already running is said, and the hold stays", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_RESTORE_IN_PROGRESS");
    });
    renderBanner(SERVER);
    await click("Restore files");
    expect(toast.info).toHaveBeenCalledWith("A restore is already running. Let it finish first.");
    expect(restoreButton()).toBeInTheDocument();
  });

  // The body already says why for a hold that cannot be restored; the
  // refusal must not add a second sentence saying the same.
  it("a member refused a restore loses the Restore button, said once", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_MEMBER_CANNOT_RESTORE");
    });
    renderBanner({ ...SERVER, side: "local" });
    await click("Restore files");
    expect(restoreButton()).toBeNull();
    expect(screen.getAllByText(/Only the owner of this shared drive/)).toHaveLength(1);
  });

  it("any other failure is a toast, and the buttons stay", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw { kind: "Hcfs", message: "disk full" };
    });
    renderBanner(SERVER);
    await click("Restore files");
    expect(toast.error).toHaveBeenCalledWith("Couldn't send your choice", {
      description: "disk full",
    });
    expect(restoreButton()).toBeInTheDocument();
  });

  it("a member's local-side hold hides Restore and warns on Remove", async () => {
    renderBanner({ ...SERVER, side: "local", canRestore: false });
    const banner = screen.getByRole("region");
    expect(banner).toHaveAccessibleName("150 files in “Photos” are missing from Hippius");
    expect(restoreButton()).toBeNull();

    await click("Remove from this Mac");
    expect(await screen.findByText(/shared drive you are a member of/)).toBeInTheDocument();
  });

  it("an own local-side hold carries the renamed-elsewhere caveat", () => {
    renderBanner({ ...SERVER, side: "local" });
    expect(screen.getByText(/renamed or moved the folder on another device/)).toBeInTheDocument();
    expect(restoreButton()).toBeInTheDocument();
  });

  it("a restoring hold offers no answers", () => {
    renderBanner({ ...SERVER, state: "restoring" });
    expect(screen.getByRole("status")).toHaveTextContent("Restoring 150 files…");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("a refused restore says to free up space", async () => {
    const store = renderBanner(SERVER);
    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => {
        const next = new Map(prev);
        const key = holdKey("Photos", "server");
        const current = next.get(key);
        if (current) {
          next.set(key, {
            ...current,
            refusal: { reason: "insufficient_space", neededBytes: 2_000_000_000 },
          });
        }
        return next;
      });
    });
    expect(screen.getByText(/not enough free space on the disk that holds your Hippius folder/)).toHaveTextContent(
      "2 GB needed",
    );
  });

  // A banner with buttons is a labelled region, not an alert (an alert's
  // content is read out at once and is not meant to hold controls); what
  // changes in it is announced by a polite status line that is always there.
  it("is a labelled region with a polite status line", () => {
    renderBanner(SERVER);
    expect(screen.queryByRole("alert")).toBeNull();
    const banner = screen.getByRole("region", { name: /150 of 200 files/ });
    const status = within(banner).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("a changed count is announced in the status line", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_HOLD_CHANGED", { held: 180 });
    });
    renderBanner(SERVER);
    await click("Restore files");
    expect(screen.getByRole("status")).toHaveTextContent(/changed to 180/);
  });

  // The safe answer is the default: a hold that appears, or asks again with
  // a new count, puts focus on Restore.
  it("focuses Restore when a hold appears and when its count changes", async () => {
    const store = renderBanner(SERVER);
    expect(restoreButton()).toHaveFocus();

    screen.getByRole("button", { name: "Decide later" }).focus();
    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, { ...SERVER, count: 170 }));
    });
    expect(restoreButton()).toHaveFocus();
  });

  it("focuses Decide later when this account cannot restore", () => {
    renderBanner({ ...SERVER, side: "local", canRestore: false });
    expect(screen.getByRole("button", { name: "Decide later" })).toHaveFocus();
  });

  // Answering removes the buttons; focus must land on the banner's status
  // line, not fall back to the page body where a keyboard user is lost.
  it("moves focus to the status line when an answer removes the buttons", async () => {
    tauri.onInvoke("restore_mass_delete", () => undefined);
    renderBanner(SERVER);
    await click("Restore files");
    await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
  });

  it("moves focus to the status line after confirming Remove", async () => {
    tauri.onInvoke("confirm_mass_delete", () => undefined);
    renderBanner(SERVER);
    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await click("Remove 150 files");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Removing 150 files…"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveFocus());
  });

  it("shows one banner per drive side", () => {
    renderBanner(SERVER, { ...SERVER, label: "Docs", side: "local" });
    expect(screen.getAllByRole("region")).toHaveLength(2);
  });
});
