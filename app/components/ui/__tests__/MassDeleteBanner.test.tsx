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

/** A hold as Rust sends it, its title and lines written the way Rust's
 *  `hold_text` writes them (pinned there); the banner only shows them. */
function rustHold(fields: Omit<MassDeleteHold, "title" | "body">): MassDeleteHold {
  const n = (count: number) => count.toLocaleString("en-US");
  if (fields.side === "server") {
    const body = ["Nothing has been deleted from Hippius yet."];
    if (fields.emptyRoot) body.push("If an external disk or cloud folder is disconnected, reconnect it.");
    return {
      ...fields,
      title: `${n(fields.count)} of ${n(fields.syncedCount)} files in “${fields.label}” are missing from this Mac`,
      body,
    };
  }
  return {
    ...fields,
    title: `${n(fields.count)} files in “${fields.label}” are missing from Hippius`,
    body: [
      "Nothing has been deleted from this Mac yet.",
      fields.canRestore
        ? "If you renamed or moved the folder on another device, restoring uploads the old copies again."
        : "Only the owner of this shared drive can put them back on Hippius.",
    ],
  };
}

const SERVER_FIELDS = {
  label: "Photos",
  side: "server",
  state: "held",
  count: 150,
  syncedCount: 200,
  emptyRoot: false,
  canRestore: true,
} as const;

/** The server-side hold, with `overrides` applied before Rust's words are
 *  written, so a changed count carries its own title. */
const hold = (overrides: Partial<Omit<MassDeleteHold, "title" | "body">> = {}) =>
  rustHold({ ...SERVER_FIELDS, ...overrides });

const SERVER: MassDeleteHold = hold();

/** Rust's sentence for each refusal (`NotReadyKind`'s Display). */
const RUST_MESSAGES: Record<string, string> = {
  MASS_DELETE_NOTHING_HELD: "These files are no longer waiting for a decision.",
  MASS_DELETE_RESTORE_IN_PROGRESS: "A restore is already running. Let it finish first.",
  MASS_DELETE_MEMBER_CANNOT_RESTORE:
    "Only the owner of this shared drive can put these files back on Hippius.",
};

const notReady = (subkind: string, extra: Record<string, unknown> = {}) => ({
  kind: "NotReady",
  subkind,
  message:
    subkind === "MASS_DELETE_HOLD_CHANGED"
      ? `The number of missing files changed to ${Number(extra.held).toLocaleString("en-US")}. ` +
        "Check it and choose again."
      : RUST_MESSAGES[subkind],
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

/** The banner's own status line (the page-wide announcer is another). */
const bannerStatus = () => within(screen.getByRole("region")).getByRole("status");

const announcer = () => screen.getByTestId("mass-delete-announcer");

/** A banner next to a text field, as on a page the user is typing in. */
function renderBesideInput(...holds: MassDeleteHold[]) {
  const store = createStore();
  store.set(
    massDeleteHoldsAtom,
    holds.reduce((map, hold) => applyHeld(map, hold), new Map()),
  );
  render(
    <Provider store={store}>
      <input aria-label="Search" />
      <MassDeleteBanner />
    </Provider>,
  );
  return store;
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

describe("MassDeleteBanner", () => {
  it("renders no banner without a hold", () => {
    renderBanner();
    expect(screen.queryByRole("region")).toBeNull();
    expect(announcer()).toBeEmptyDOMElement();
  });

  it("announces a server-side hold with its counts, Restore first", () => {
    renderBanner(hold({ emptyRoot: true }));
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
    expect(bannerStatus()).toHaveTextContent("Restoring 150 files…");
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
    expect(bannerStatus()).toHaveTextContent("Removing 150 files…");
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
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, hold({ count: 180 })));
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
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, hold({ count: 160 })));
    });
    expect(screen.getByRole("region")).toHaveAccessibleName(/160 of 200 files/);
  });

  it("a changed hold shows the new count and asks again", async () => {
    tauri.onInvoke("confirm_mass_delete", () => {
      throw notReady("MASS_DELETE_HOLD_CHANGED", { held: 180 });
    });
    tauri.onInvoke("get_mass_delete_holds", () => [hold({ count: 180 })]);
    renderBanner(SERVER);
    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await click("Remove 150 files");

    expect(screen.getByRole("region")).toHaveAccessibleName(/180 of 200 files/);
    expect(screen.getByText(/changed to 180\. Check it and choose again\./)).toBeInTheDocument();
    expect(restoreButton()).toBeInTheDocument();
  });

  // The refusal carries only the new count. The rest of the hold (the
  // baseline it was measured against, the empty-root advice) is read back
  // from Rust, so the title does not mix a new count with an old baseline.
  it("a changed hold is read back whole from Rust", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_HOLD_CHANGED", { held: 180 });
    });
    tauri.onInvoke("get_mass_delete_holds", () => [hold({ count: 180, syncedCount: 220 })]);
    renderBanner(SERVER);
    await click("Restore files");

    await waitFor(() =>
      expect(screen.getByRole("region")).toHaveAccessibleName(/180 of 220 files/),
    );
    expect(screen.getByText(/changed to 180\. Check it and choose again\./)).toBeInTheDocument();
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

  // Rust writes every refusal's words; the banner decides only what to do.
  it("says a refusal in Rust's words, not its own", async () => {
    tauri.onInvoke("confirm_mass_delete", () => {
      throw { kind: "NotReady", subkind: "MASS_DELETE_RESTORE_IN_PROGRESS", message: "Rust's words." };
    });
    renderBanner(SERVER);
    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await click("Remove 150 files");
    expect(toast.info).toHaveBeenCalledWith("Rust's words.");
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

  // Rust's hold said this account could restore, so its lines do not say
  // who can; the refusal's sentence does, once.
  it("a member refused a restore loses the Restore button, said once", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_MEMBER_CANNOT_RESTORE");
    });
    renderBanner(hold({ side: "local" }));
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
    renderBanner(hold({ side: "local", canRestore: false }));
    const banner = screen.getByRole("region");
    expect(banner).toHaveAccessibleName("150 files in “Photos” are missing from Hippius");
    expect(restoreButton()).toBeNull();

    await click("Remove from this Mac");
    expect(await screen.findByText(/shared drive you are a member of/)).toBeInTheDocument();
  });

  it("an own local-side hold carries the renamed-elsewhere caveat", () => {
    renderBanner(hold({ side: "local" }));
    expect(screen.getByText(/renamed or moved the folder on another device/)).toBeInTheDocument();
    expect(restoreButton()).toBeInTheDocument();
  });

  it("a restoring hold offers no answers", () => {
    renderBanner(hold({ state: "restoring" }));
    expect(bannerStatus()).toHaveTextContent("Restoring 150 files…");
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
    expect(bannerStatus()).toHaveTextContent(/changed to 180/);
  });

  // The safe answer is the default: a hold that appears, or asks again with
  // a new count, puts focus on Restore.
  it("focuses Restore when a hold appears with nothing focused, and when its count changes", async () => {
    const store = renderBanner(SERVER);
    await waitFor(() => expect(restoreButton()).toHaveFocus());

    screen.getByRole("button", { name: "Decide later" }).focus();
    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, hold({ count: 170 })));
    });
    await waitFor(() => expect(restoreButton()).toHaveFocus());
  });

  it("focuses Decide later when this account cannot restore", async () => {
    renderBanner(hold({ side: "local", canRestore: false }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Decide later" })).toHaveFocus());
  });

  // A hold arrives on its own (a cycle, or hydration at launch) while the
  // user is typing elsewhere: moving focus would send their keystrokes
  // into the banner. The always-mounted live region says it instead.
  it("leaves focus where the user is typing when a hold appears", async () => {
    const store = renderBesideInput();
    const input = screen.getByRole("textbox", { name: "Search" });
    input.focus();

    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, SERVER));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input).toHaveFocus();
    expect(announcer()).toHaveTextContent("150 of 200 files in “Photos” are missing from this Mac");

    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, hold({ count: 170 })));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input).toHaveFocus();
    expect(announcer()).toHaveTextContent("150 of 200 files");
    expect(announcer()).not.toHaveTextContent("170");
  });

  it("announces through a polite region that is there before any banner", () => {
    renderBanner();
    expect(announcer()).toHaveAttribute("aria-live", "polite");
  });

  // Asked again after their own click: the user is answering, so focus
  // goes back to the safe answer, even from the closed confirmation.
  it("focuses Restore when the hold changed under the user's answer", async () => {
    tauri.onInvoke("confirm_mass_delete", () => {
      throw notReady("MASS_DELETE_HOLD_CHANGED", { held: 180 });
    });
    renderBesideInput(SERVER);
    screen.getByRole("textbox", { name: "Search" }).focus();
    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await click("Remove 150 files");

    await waitFor(() => expect(restoreButton()).toHaveFocus());
  });

  // Answering removes the buttons; focus must land on the banner's status
  // line, not fall back to the page body where a keyboard user is lost.
  it("moves focus to the status line when an answer removes the buttons", async () => {
    tauri.onInvoke("restore_mass_delete", () => undefined);
    renderBanner(SERVER);
    await click("Restore files");
    await waitFor(() => expect(bannerStatus()).toHaveFocus());
  });

  it("moves focus to the status line after confirming Remove", async () => {
    tauri.onInvoke("confirm_mass_delete", () => undefined);
    renderBanner(SERVER);
    await click("Remove from Hippius");
    await screen.findByText("Remove 150 files from Hippius?");
    await click("Remove 150 files");
    await waitFor(() => expect(bannerStatus()).toHaveTextContent("Removing 150 files…"));
    await waitFor(() => expect(bannerStatus()).toHaveFocus());
  });

  // Restore is gone after the refusal; focus must not fall to the page
  // body with it, and the next answer this account can give is Decide later.
  it("moves focus to Decide later when a member's restore is refused", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_MEMBER_CANNOT_RESTORE");
    });
    renderBanner(hold({ side: "local" }));
    await waitFor(() => expect(restoreButton()).toHaveFocus());
    await click("Restore files");
    await waitFor(() => expect(screen.getByRole("button", { name: "Decide later" })).toHaveFocus());
  });

  it("Decide later moves focus to the next banner's Restore before it goes", async () => {
    renderBanner(SERVER, hold({ label: "Docs" }));
    const [first] = screen.getAllByRole("button", { name: "Decide later" });
    first?.focus();
    await act(async () => {
      if (first) fireEvent.click(first);
    });
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Restore files" })).toHaveFocus();
  });

  it("Decide later on the last banner moves focus to the page's heading", async () => {
    const store = createStore();
    store.set(massDeleteHoldsAtom, applyHeld(new Map(), SERVER));
    render(
      <Provider store={store}>
        <MassDeleteBanner />
        <main>
          <h1>Files</h1>
        </main>
      </Provider>,
    );
    await click("Decide later");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByRole("heading", { name: "Files" })).toHaveFocus();
  });

  // The announcer says what arrived; it does not read every banner out
  // again when one changes (the status line covers a refused answer).
  it("announces only the hold that arrived", async () => {
    const store = renderBanner(SERVER);
    expect(announcer()).toHaveTextContent("150 of 200 files in “Photos”");
    expect(announcer()).not.toHaveAttribute("aria-atomic", "true");

    await act(async () => {
      store.set(massDeleteHoldsAtom, (prev) => applyHeld(prev, hold({ label: "Docs", count: 120 })));
    });
    expect(announcer()).toHaveTextContent("120 of 200 files in “Docs”");
    expect(announcer()).not.toHaveTextContent("Photos");
  });

  // A refused answer is said once, in the banner's status line; the
  // announcer does not repeat the changed hold.
  it("a changed count under the user's answer is not announced twice", async () => {
    tauri.onInvoke("restore_mass_delete", () => {
      throw notReady("MASS_DELETE_HOLD_CHANGED", { held: 1800 });
    });
    renderBanner(SERVER);
    await click("Restore files");
    expect(bannerStatus()).toHaveTextContent("The number of missing files changed to 1,800.");
    expect(announcer()).not.toHaveTextContent("1,800");
  });

  it("shows one banner per drive side", () => {
    renderBanner(SERVER, hold({ label: "Docs", side: "local" }));
    expect(screen.getAllByRole("region")).toHaveLength(2);
  });
});
