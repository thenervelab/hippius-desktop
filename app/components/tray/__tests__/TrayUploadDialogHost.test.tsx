import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore, type PrimitiveAtom } from "jotai";

// The main-window half of the popover's Upload tile: the event in, the
// Drive's own "Upload File" dialog out, behind the Upload button's gates.

type Handler = (event: { payload: unknown }) => void;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: Handler) => {
    handlers.set(name, cb);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

vi.mock("@/app/lib/global-atoms/unpinAtoms", async () => {
  const { atom } = await import("jotai");
  return { hasConfiguredDrivesAtom: atom(true) };
});

const room = vi.hoisted(() => ({ allowed: true, calls: [] as unknown[][] }));
vi.mock("@/app/lib/hooks/useCreditCheck", () => ({
  useCreditCheck: () => ({
    requireUploadRoom: async (...args: unknown[]) => {
      room.calls.push(args);
      return room.allowed;
    },
  }),
}));

const toast = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

// The dialog itself (drop area, drive choice, upload) is the Drive's own
// and is tested there; here it only has to be that dialog, opened or not.
vi.mock("@/app/components/page-sections/drive/UploadFileDialog", () => ({
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="Upload File">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    ) : null,
}));

import TrayUploadDialogHost, {
  NO_DRIVE_TO_UPLOAD_TO,
  UPLOAD_ALREADY_RUNNING,
} from "../TrayUploadDialogHost";
import { hasConfiguredDrivesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { uploadToIpfsAndSubmitToBlockcahinRequestStateAtom } from "@/app/components/page-sections/drive/atoms/query-atoms";
import { TRAY_OPEN_UPLOAD_EVENT } from "@/app/lib/tray/trayDrop";

function mount() {
  const store = createStore();
  render(
    <Provider store={store}>
      <TrayUploadDialogHost />
    </Provider>,
  );
  return store;
}

async function pressUploadTile() {
  const handler = handlers.get(TRAY_OPEN_UPLOAD_EVENT);
  expect(handler).toBeDefined();
  await act(async () => handler?.({ payload: {} }));
}

beforeEach(() => {
  handlers.clear();
  room.allowed = true;
  room.calls = [];
  toast.warning.mockClear();
  toast.info.mockClear();
});

describe("the tray's Upload tile in the main window", () => {
  it("opens the Upload File dialog over the page, after the upload allowance check", async () => {
    mount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await pressUploadTile();
    expect(screen.getByRole("dialog", { name: "Upload File" })).toBeInTheDocument();
    expect(room.calls).toEqual([["file-upload"]]);
  });

  it("leaves a refusal to the plan dialog and opens nothing", async () => {
    room.allowed = false;
    mount();
    await pressUploadTile();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("says there is no drive to upload into yet, like the Upload button", async () => {
    const store = mount();
    act(() => store.set(hasConfiguredDrivesAtom as unknown as PrimitiveAtom<boolean>, false));
    await pressUploadTile();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalledWith(NO_DRIVE_TO_UPLOAD_TO);
  });

  it("does not open a second upload while one is running", async () => {
    const store = mount();
    act(() => store.set(uploadToIpfsAndSubmitToBlockcahinRequestStateAtom, "uploading"));
    await pressUploadTile();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith(UPLOAD_ALREADY_RUNNING);
    expect(room.calls).toEqual([]);
  });

  it("closes, and opens again on the next press", async () => {
    mount();
    await pressUploadTile();
    act(() => screen.getByRole("button", { name: "Cancel" }).click());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await pressUploadTile();
    expect(screen.getByRole("dialog", { name: "Upload File" })).toBeInTheDocument();
  });
});
