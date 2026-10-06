import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const h = vi.hoisted(() => ({
  pick: vi.fn<() => Promise<string | null>>(async () => null),
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => h.pick() }));
vi.mock("sonner", () => ({ toast: h.toast }));

import CaptureDriveDialog, { shownLocation } from "../CaptureDriveDialog";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import type { CaptureDriveLocation, CaptureDriveStatus } from "@/app/lib/tauri/capture";

const DOCS: CaptureDriveLocation = {
  path: "/Users/a/Documents/Hippius Captures",
  place: "Documents › Hippius Captures",
  permissionNote: "macOS will ask to let Hippius use your Documents folder. Choose Allow so your captures can be saved there.",
};
const PICTURES: CaptureDriveLocation = {
  path: "/Users/a/Pictures/Hippius Captures",
  place: "Pictures › Hippius Captures",
  permissionNote: null,
};
const READY: CaptureDriveStatus = {
  state: "ready",
  label: "Hippius Captures",
  name: "Hippius Captures",
  remote: false,
  location: DOCS,
};

function openWith(status: CaptureDriveStatus) {
  tauri.onInvoke("capture_drive_status", () => status);
  const store = createStore();
  store.set(captureDialogAtom, { kind: "captureDrive" });
  render(
    <Provider store={store}>
      <CaptureDriveDialog />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  tauri.reset();
  h.pick.mockReset();
  h.pick.mockResolvedValue(null);
  for (const fn of Object.values(h.toast)) fn.mockReset();
});

describe("the first capture's question", () => {
  it("says where the folder goes and what macOS will ask, and creates it there", async () => {
    tauri.onInvoke("capture_drive_create", () => READY);
    const store = openWith({ state: "needsSetup", suggested: DOCS, waiting: 1 });
    expect(await screen.findByText("Documents › Hippius Captures")).toBeInTheDocument();
    expect(screen.getByText(DOCS.permissionNote!)).toBeInTheDocument();
    // The capture just taken is safe meanwhile, and the user is told so.
    expect(screen.getByText(/The capture you just took is safe on this computer/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_drive_create", { folder: null }));
    await waitFor(() => expect(store.get(captureDialogAtom)).toBeNull());
    expect(h.toast.success).toHaveBeenCalledWith("Captures are saved in Documents › Hippius Captures.");
  });

  it("creates it in another place the user picks, as Rust names it", async () => {
    h.pick.mockResolvedValue("/Users/a/Pictures");
    tauri.onInvoke("capture_drive_location", () => PICTURES);
    tauri.onInvoke("capture_drive_create", () => ({ ...READY, location: PICTURES }));
    openWith({ state: "needsSetup", suggested: DOCS, waiting: 0 });
    await screen.findByText("Documents › Hippius Captures");

    fireEvent.click(screen.getByRole("button", { name: "Choose another location" }));
    expect(await screen.findByText("Pictures › Hippius Captures")).toBeInTheDocument();
    expect(tauri.core.invoke).toHaveBeenCalledWith("capture_drive_location", { folder: "/Users/a/Pictures" });
    // No protected folder there: no macOS note.
    expect(screen.queryByText(DOCS.permissionNote!)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_drive_create", { folder: PICTURES.path }),
    );
  });

  it("shows Rust's reason when a picked place cannot be used", async () => {
    h.pick.mockResolvedValue("/Users/a/Work");
    tauri.onInvoke("capture_drive_location", () => {
      throw { kind: "Validation", message: "That place is inside your drive “Work”." };
    });
    openWith({ state: "needsSetup", suggested: DOCS, waiting: 0 });
    await screen.findByText("Documents › Hippius Captures");
    fireEvent.click(screen.getByRole("button", { name: "Choose another location" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That place is inside your drive “Work”.");
    // The suggested place still stands.
    expect(screen.getByText("Documents › Hippius Captures")).toBeInTheDocument();
  });

  it("stays open with Rust's reason when the folder cannot be made", async () => {
    tauri.onInvoke("capture_drive_create", () => {
      throw { kind: "Validation", message: "Hippius isn't allowed to use your Documents folder." };
    });
    const store = openWith({ state: "needsSetup", suggested: DOCS, waiting: 1 });
    await screen.findByText("Documents › Hippius Captures");
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hippius isn't allowed to use your Documents folder.");
    expect(store.get(captureDialogAtom)).toEqual({ kind: "captureDrive" });
  });

  // Plan full, no encryption password, offline: the folder is kept and Rust
  // says what is in the way.
  it("says why when the drive cannot be added yet", async () => {
    tauri.onInvoke("capture_drive_create", () => ({
      state: "pending",
      location: DOCS,
      message: "Your captures are kept on this computer in Documents › Hippius Captures until Hippius can upload them.",
    }));
    const store = openWith({ state: "needsSetup", suggested: DOCS, waiting: 1 });
    await screen.findByText("Documents › Hippius Captures");
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() => expect(store.get(captureDialogAtom)).toBeNull());
    expect(h.toast.warning).toHaveBeenCalledWith(
      "Your captures are kept on this computer in Documents › Hippius Captures until Hippius can upload them.",
    );
  });

  // Not now: the capture is not lost, and the user hears where it is.
  it("keeps the capture and says so when the user says Not now", async () => {
    const store = openWith({ state: "needsSetup", suggested: DOCS, waiting: 1 });
    await screen.findByText("Documents › Hippius Captures");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(store.get(captureDialogAtom)).toBeNull();
    expect(h.toast.info).toHaveBeenCalledWith(expect.stringContaining("kept on this computer"));
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_drive_create", expect.anything());
  });

  it("tries the chosen folder again while its drive is not there yet", async () => {
    tauri.onInvoke("capture_drive_create", () => READY);
    openWith({ state: "pending", location: DOCS, message: "Upgrade your plan to upload it and get a link." });
    expect(await screen.findByText("Upgrade your plan to upload it and get a link.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("capture_drive_create", { folder: DOCS.path }));
  });
});

describe("moving the captures folder", () => {
  it("moves only once another place is picked", async () => {
    h.pick.mockResolvedValue("/Users/a/Pictures");
    tauri.onInvoke("capture_drive_location", () => PICTURES);
    tauri.onInvoke("capture_drive_create", () => ({ ...READY, location: PICTURES }));
    openWith(READY);
    expect(await screen.findByText("Move your captures folder")).toBeInTheDocument();
    expect(screen.getByText(/Captures you already took stay where they are/)).toBeInTheDocument();
    const use = screen.getByRole("button", { name: "Use this folder" });
    expect(use).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose another location" }));
    });
    await screen.findByText("Pictures › Hippius Captures");
    expect(use).not.toBeDisabled();
    fireEvent.click(use);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_drive_create", { folder: PICTURES.path }),
    );
    expect(h.toast.success).toHaveBeenCalledWith("Captures are saved in Pictures › Hippius Captures.");
  });
});

describe("shownLocation", () => {
  it("shows the picked place first, then Rust's for the state", () => {
    expect(shownLocation(null, null)).toBeNull();
    expect(shownLocation({ state: "needsSetup", suggested: DOCS, waiting: 0 }, null)).toBe(DOCS);
    expect(shownLocation({ state: "pending", location: DOCS, message: "" }, null)).toBe(DOCS);
    expect(shownLocation(READY, PICTURES)).toBe(PICTURES);
    expect(shownLocation({ ...READY, location: null }, null)).toBeNull();
  });
});
