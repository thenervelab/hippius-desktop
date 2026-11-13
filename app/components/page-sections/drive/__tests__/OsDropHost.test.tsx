import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

// Files dropped on the main window from the OS, on every view that takes
// them: Recent Files, the drive list and Shared Drives ask which drive;
// inside a drive (local or remote) and inside its folders the drop goes
// there. The Tauri webview drop event is mocked; so are the upload dialogs
// (each has its own tests) and the remote upload calls.

type DragPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };
const drag = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: DragPayload }) => void),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: DragPayload }) => void) => {
      drag.handler = cb;
      return Promise.resolve(() => {
        drag.handler = null;
      });
    },
  }),
}));

// Which dropped paths are folders (the real one stats them through Rust).
const classified = vi.hoisted(() => ({ folders: new Set<string>(), unreadable: new Set<string>() }));
vi.mock("@/lib/utils/filterDroppedPaths", () => ({
  filterDroppedPaths: async (paths: string[]) => ({
    files: paths.filter((p) => !classified.folders.has(p) && !classified.unreadable.has(p)),
    folders: paths.filter((p) => classified.folders.has(p)),
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

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Account" }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
const mutated = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/app/lib/utils/fileMutationEvents", () => ({ notifyFilesMutated: mutated }));

const remote = vi.hoisted(() => ({
  files: vi.fn(async (args: { onUploaded?: () => void }) => args.onUploaded?.()),
  folder: vi.fn(async (args: { onUploaded?: () => void }) => args.onUploaded?.()),
}));
vi.mock("@/app/lib/hooks/useRemoteUploadActions", () => ({
  uploadPathsToRemoteFolder: remote.files,
  uploadFolderPathToRemoteFolder: remote.folder,
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

vi.mock("@/app/components/page-sections/drive/UploadFileDialog", () => ({
  default: (props: {
    open: boolean;
    initialPaths: string[] | null;
    defaultFolderLabel: string | null;
    nestedUpload?: { folderName: string; subfolder?: string };
  }) =>
    props.open ? (
      <div
        role="dialog"
        aria-label="Upload File"
        data-paths={props.initialPaths?.join(",")}
        data-drive={props.defaultFolderLabel ?? ""}
        data-folder={props.nestedUpload?.subfolder ?? ""}
      />
    ) : null,
}));
vi.mock("@/app/components/page-sections/drive/FolderUploadDialog", () => ({
  default: (props: { open: boolean; initialFolderPath?: string; defaultFolderLabel?: string | null }) =>
    props.open ? (
      <div
        role="dialog"
        aria-label="Upload Folder"
        data-path={props.initialFolderPath}
        data-drive={props.defaultFolderLabel ?? ""}
      />
    ) : null,
}));

import OsDropHost from "../OsDropHost";
import { claimOsDrops, registerOsDropTarget, type OsDropTarget } from "@/app/lib/drive/osDrop";
import { setInAppDragActive } from "@/app/lib/drive-move/inAppDrag";
import { parkTrayDrop } from "@/app/lib/tray/trayDrop";

const cleanups: Array<() => void> = [];
function onView(target: OsDropTarget) {
  cleanups.push(registerOsDropTarget(() => target));
}

async function mount() {
  render(
    <Provider store={createStore()}>
      <OsDropHost />
    </Provider>,
  );
  // The listener is registered after a dynamic import.
  await vi.waitFor(() => expect(drag.handler).not.toBeNull());
}

const at = { x: 10, y: 10 };
async function dragIn(paths: string[]) {
  await act(async () => drag.handler?.({ payload: { type: "enter", paths, position: at } }));
}
async function drop(paths: string[]) {
  await act(async () => {
    drag.handler?.({ payload: { type: "drop", paths, position: at } });
    // Let the classification and the gates settle.
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  drag.handler = null;
  classified.folders = new Set();
  classified.unreadable = new Set();
  room.allowed = true;
  room.calls = [];
  remote.files.mockClear();
  remote.folder.mockClear();
  mutated.mockClear();
  toast.error.mockClear();
  toast.info.mockClear();
  toast.warning.mockClear();
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  setInAppDragActive(false);
});

describe("where no drive is on screen (Recent Files, the drive list, Shared Drives)", () => {
  it("opens the Upload File dialog with the files and asks which drive", async () => {
    onView({ destination: { kind: "choose" }, name: "Drive" });
    await mount();
    await drop(["/Users/me/a.png", "/Users/me/b.pdf"]);
    const dialog = screen.getByRole("dialog", { name: "Upload File" });
    expect(dialog).toHaveAttribute("data-paths", "/Users/me/a.png,/Users/me/b.pdf");
    // No drive preselected: the dialog's drive picker asks.
    expect(dialog).toHaveAttribute("data-drive", "");
    expect(room.calls).toEqual([["file-upload", false, null]]);
  });

  it("opens the Upload Folder dialog for a dropped folder, still asking which drive", async () => {
    classified.folders = new Set(["/Users/me/Trip"]);
    onView({ destination: { kind: "choose" }, name: "Drive" });
    await mount();
    await drop(["/Users/me/Trip"]);
    const dialog = screen.getByRole("dialog", { name: "Upload Folder" });
    expect(dialog).toHaveAttribute("data-path", "/Users/me/Trip");
    expect(dialog).toHaveAttribute("data-drive", "");
    expect(room.calls).toEqual([["folder-upload", false, null]]);
  });
});

describe("inside a drive synced here", () => {
  it("opens the Upload File dialog on that drive, without asking", async () => {
    onView({ destination: { kind: "local", label: "Photos" }, name: "Photos" });
    await mount();
    await drop(["/Users/me/a.png"]);
    expect(screen.getByRole("dialog", { name: "Upload File" })).toHaveAttribute(
      "data-drive",
      "Photos",
    );
  });

  it("uploads into the folder that is open", async () => {
    onView({
      destination: {
        kind: "local",
        label: "Photos",
        folder: { name: "2024", subfolder: "Trips/2024", syncBasePath: "/u/Photos" },
      },
      name: "2024",
    });
    await mount();
    await drop(["/Users/me/a.png"]);
    expect(screen.getByRole("dialog", { name: "Upload File" })).toHaveAttribute(
      "data-folder",
      "Trips/2024",
    );
  });

  it("hands a dropped folder to the drive's own folder dialog", async () => {
    classified.folders = new Set(["/Users/me/Trip"]);
    const openFolder = vi.fn();
    onView({ destination: { kind: "local", label: "Photos" }, name: "Photos", openFolder });
    await mount();
    await drop(["/Users/me/Trip"]);
    expect(openFolder).toHaveBeenCalledWith("/Users/me/Trip");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("says which folder is used when several are dropped", async () => {
    classified.folders = new Set(["/a", "/b"]);
    const openFolder = vi.fn();
    onView({ destination: { kind: "local", label: "Photos" }, name: "Photos", openFolder });
    await mount();
    await drop(["/a", "/b"]);
    expect(openFolder).toHaveBeenCalledWith("/a");
    expect(toast.info).toHaveBeenCalledWith("Only the first dropped folder will be used.");
  });
});

describe("inside a drive that is not synced here", () => {
  it("uploads the files straight to that drive's folder", async () => {
    const onUploaded = vi.fn();
    onView({
      destination: { kind: "remote", label: "Work", parentPath: "Clients" },
      name: "Clients",
      onUploaded,
    });
    await mount();
    await drop(["/Users/me/a.png"]);
    expect(remote.files).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "5Account",
        label: "Work",
        parentPath: "Clients",
        paths: ["/Users/me/a.png"],
      }),
    );
    expect(onUploaded).toHaveBeenCalled();
    expect(mutated).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uploads a dropped folder straight there too", async () => {
    classified.folders = new Set(["/Users/me/Trip"]);
    onView({ destination: { kind: "remote", label: "shared:5Abc~f00" }, name: "Team" });
    await mount();
    await drop(["/Users/me/Trip"]);
    expect(remote.folder).toHaveBeenCalledWith(
      expect.objectContaining({ label: "shared:5Abc~f00", folderPath: "/Users/me/Trip" }),
    );
    // The drive is named, so a drive shared with this account is judged on
    // its owner's room, not this account's plan.
    expect(room.calls).toEqual([["folder-upload", false, "shared:5Abc~f00"]]);
  });
});

describe("a drop that cannot upload says why", () => {
  it("refuses a Viewer on a shared drive with the role's words", async () => {
    onView({
      destination: { kind: "remote", label: "shared:5Abc~f00" },
      name: "Team",
      writeRefusal: "You have Viewer access to this drive.",
    });
    await mount();
    await drop(["/Users/me/a.png"]);
    expect(toast.error).toHaveBeenCalledWith("You have Viewer access to this drive.");
    expect(remote.files).not.toHaveBeenCalled();
  });

  it("refuses a drive with no folder on this computer", async () => {
    onView({ destination: null, name: "Photos", blockedReason: "Set it up first." });
    await mount();
    await drop(["/Users/me/a.png"]);
    expect(toast.error).toHaveBeenCalledWith("Set it up first.");
  });

  it("opens nothing when the plan has no room (the plan dialog explains)", async () => {
    room.allowed = false;
    onView({ destination: { kind: "choose" }, name: "Drive", storageBlocked: true });
    await mount();
    await drop(["/Users/me/a.png"]);
    expect(room.calls).toEqual([["file-upload", true, null]]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says so when nothing dropped could be read", async () => {
    classified.unreadable = new Set(["/gone"]);
    onView({ destination: { kind: "choose" }, name: "Drive" });
    await mount();
    await drop(["/gone"]);
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't read what was dropped. Try again, or use the Upload button.",
    );
  });

  it("uploads the files of a mixed drop and says the folders were skipped", async () => {
    classified.folders = new Set(["/dir"]);
    onView({ destination: { kind: "choose" }, name: "Drive" });
    await mount();
    await drop(["/a.png", "/dir"]);
    expect(screen.getByRole("dialog", { name: "Upload File" })).toHaveAttribute(
      "data-paths",
      "/a.png",
    );
    expect(toast.info).toHaveBeenCalledWith(
      'Folders were skipped. Use "Upload Folder" to upload a folder.',
    );
  });
});

describe("drops that belong to something else", () => {
  it("never treats a row dragged inside the app as an upload", async () => {
    onView({ destination: { kind: "choose" }, name: "Drive" });
    await mount();
    setInAppDragActive(true);
    await dragIn(["/a.png"]);
    expect(screen.queryByTestId("os-drop-overlay")).not.toBeInTheDocument();
    await drop(["/a.png"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(room.calls).toEqual([]);
  });

  it("leaves a drop to an open dialog with its own drop area", async () => {
    onView({ destination: { kind: "choose" }, name: "Drive" });
    await mount();
    const release = claimOsDrops();
    await drop(["/a.png"]);
    release();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does nothing on a page that takes no drops", async () => {
    await mount();
    await dragIn(["/a.png"]);
    expect(screen.queryByTestId("os-drop-overlay")).not.toBeInTheDocument();
    await drop(["/a.png"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("the drag overlay", () => {
  it("names the destination where a drop will be taken, and goes on leave", async () => {
    onView({ destination: { kind: "local", label: "Photos" }, name: "Photos" });
    await mount();
    await dragIn(["/a.png"]);
    expect(screen.getByTestId("os-drop-overlay")).toHaveTextContent("Photos");
    await act(async () => drag.handler?.({ payload: { type: "leave" } }));
    expect(screen.queryByTestId("os-drop-overlay")).not.toBeInTheDocument();
  });

  it("is not shown where the drop will be refused", async () => {
    onView({ destination: { kind: "choose" }, name: "Drive", writeRefusal: "No." });
    await mount();
    await dragIn(["/a.png"]);
    expect(screen.queryByTestId("os-drop-overlay")).not.toBeInTheDocument();
  });
});

describe("files dropped on the tray popover", () => {
  it("are taken once a view that takes drops is on screen", async () => {
    await mount();
    parkTrayDrop(["/Users/me/a.png"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      onView({ destination: { kind: "choose" }, name: "Drive" });
      await new Promise((r) => setTimeout(r, 0));
    });
    await vi.waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Upload File" })).toHaveAttribute(
        "data-paths",
        "/Users/me/a.png",
      ),
    );
  });
});
