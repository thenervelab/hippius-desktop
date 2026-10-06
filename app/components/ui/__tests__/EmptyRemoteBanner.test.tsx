// The empty-drive prompt: the owner's two-step removal, the member who is
// never offered it, "Keep my files", and each refusal kind Rust can answer
// with. Only the IPC boundary and the toasts are mocked; the atom, the
// reducer and the copy are real.

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

import EmptyRemoteBanner from "../EmptyRemoteBanner";
import { emptyRemoteDrivesAtom } from "@/app/lib/store/syncAtoms";
import { applyCleared, applyHeld } from "@/app/lib/emptyRemote/drives";
import type { EmptyRemoteDrive } from "@/app/lib/tauri/emptyRemote";

/** A prompt as Rust sends it, its words written the way Rust's
 *  `empty_remote_text` writes them (pinned there). */
function rustDrive(fields: Omit<EmptyRemoteDrive, "title" | "body">): EmptyRemoteDrive {
  const n = fields.syncedCount.toLocaleString("en-US");
  return {
    ...fields,
    title: `Hippius has no files in “${fields.label}”`,
    body: [
      `This Mac still has ${n} files from it. Nothing has been deleted, and this drive does not sync until this is resolved.`,
      fields.canConfirm
        ? "If you emptied this drive on purpose, you can remove the files here too."
        : "This is a shared drive. If its owner emptied or deleted it, your copies may be the only ones left, so they are kept. Remove the drive to stop syncing it.",
    ],
  };
}

const OWNED = rustDrive({ label: "Photos", syncedCount: 1200, canConfirm: true });
const MEMBER = rustDrive({ label: "Team", syncedCount: 30, canConfirm: false });

const notReady = (subkind: string, message: string) => ({ kind: "NotReady", subkind, message });

beforeEach(() => {
  tauri.reset();
  vi.clearAllMocks();
});

function renderBanner(...drives: EmptyRemoteDrive[]) {
  const store = createStore();
  store.set(
    emptyRemoteDrivesAtom,
    drives.reduce((map, drive) => applyHeld(map, drive), new Map()),
  );
  render(
    <Provider store={store}>
      <EmptyRemoteBanner />
    </Provider>,
  );
  return store;
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

const CONFIRM_TITLE = "Remove 1,200 files from this Mac?";

describe("EmptyRemoteBanner", () => {
  it("renders nothing without a prompt", () => {
    renderBanner();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("says nothing was deleted, with Keep my files first for an owner", () => {
    renderBanner(OWNED);
    const banner = screen.getByRole("region");
    expect(banner).toHaveAccessibleName("Hippius has no files in “Photos”");
    expect(within(banner).getByText(/Nothing has been deleted/)).toBeInTheDocument();

    const buttons = within(banner).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Keep my files", "The drive really is empty"]);
  });

  it("offers a shared-drive member no way to confirm, only the explanation", () => {
    renderBanner(MEMBER);
    const banner = screen.getByRole("region");
    expect(within(banner).getByText(/This is a shared drive/)).toBeInTheDocument();
    const buttons = within(banner).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Keep my files"]);
  });

  it("asks a second time, and only the destructive button confirms", async () => {
    tauri.onInvoke("confirm_empty_remote", () => undefined);
    renderBanner(OWNED);

    await click("The drive really is empty");
    expect(await screen.findByText(CONFIRM_TITLE)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep my files" }));
    });
    await waitFor(() => expect(screen.queryByText(CONFIRM_TITLE)).toBeNull());
    expect(tauri.core.invoke).not.toHaveBeenCalled();

    await click("The drive really is empty");
    await screen.findByText(CONFIRM_TITLE);
    await click("Remove 1,200 files");

    expect(tauri.core.invoke).toHaveBeenCalledWith("confirm_empty_remote", { label: "Photos" });
    expect(screen.getByText("Removing 1,200 files from this Mac…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "The drive really is empty" })).toBeNull();
  });

  it("Keep my files puts the banner away without calling Rust, and a new report brings it back", async () => {
    const store = renderBanner(OWNED);
    await click("Keep my files");

    expect(screen.queryByRole("region")).toBeNull();
    expect(tauri.core.invoke).not.toHaveBeenCalled();

    await act(async () => {
      store.set(emptyRemoteDrivesAtom, (prev) => applyHeld(prev, { ...OWNED, syncedCount: 1300 }));
    });
    expect(screen.getByRole("region")).toBeInTheDocument();
  });

  it("goes away when Rust clears the drive", async () => {
    const store = renderBanner(OWNED);
    await act(async () => {
      store.set(emptyRemoteDrivesAtom, (prev) => applyCleared(prev, "Photos"));
    });
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("a member refused by Rust loses the option and sees Rust's reason", async () => {
    const reason = "Only the owner of this shared drive can confirm it is empty.";
    tauri.onInvoke("confirm_empty_remote", () => {
      throw notReady("EMPTY_REMOTE_MEMBER_CANNOT_CONFIRM", reason);
    });
    renderBanner(OWNED);
    await click("The drive really is empty");
    await screen.findByText(CONFIRM_TITLE);
    await click("Remove 1,200 files");

    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "The drive really is empty" })).toBeNull();
  });

  it("a drive no longer waiting is refreshed from Rust", async () => {
    tauri.onInvoke("confirm_empty_remote", () => {
      throw notReady("EMPTY_REMOTE_NOTHING_HELD", "This drive is no longer waiting for a decision.");
    });
    tauri.onInvoke("get_empty_remote_drives", () => []);
    renderBanner(OWNED);
    await click("The drive really is empty");
    await screen.findByText(CONFIRM_TITLE);
    await click("Remove 1,200 files");

    expect(toast.info).toHaveBeenCalledWith("This drive is no longer waiting for a decision.");
    await waitFor(() => expect(screen.queryByRole("region")).toBeNull());
  });

  it("an unexpected failure keeps the banner and says so", async () => {
    tauri.onInvoke("confirm_empty_remote", () => {
      throw { kind: "Hcfs", message: "disk full" };
    });
    renderBanner(OWNED);
    await click("The drive really is empty");
    await screen.findByText(CONFIRM_TITLE);
    await click("Remove 1,200 files");

    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "The drive really is empty" })).toBeInTheDocument();
  });
});
