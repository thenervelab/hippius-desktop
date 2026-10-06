import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, configure } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { shareModalFileAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { renameModalFileAtom } from "@/app/lib/global-atoms/renameAtoms";
import { RENAME_DISABLED_TOOLTIP } from "@/app/lib/utils/renameGating";

configure({ asyncUtilTimeout: 5000 });

// The main-window half of the popover's row actions: an event in, the Drive's
// own dialog, route or download out.

type Handler = (event: { payload: unknown }) => void;
let handler: Handler | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, cb: Handler) => {
    handler = cb;
    return Promise.resolve(() => {});
  }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Account" }),
}));

let memberLabels = new Set<string>();
let writableLabels = new Set<string>();
vi.mock("@/app/lib/hooks/useSharedDriveRoles", () => ({
  useMemberDriveLabels: () => memberLabels,
  useWritableMemberDriveLabels: () => writableLabels,
}));

const downloadFile = vi.fn();
vi.mock("@/app/lib/utils/downloadFile", () => ({
  downloadFile: (...args: unknown[]) => downloadFile(...args),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }));

vi.mock("@/app/contexts/FileSelectionContext", () => ({
  FileSelectionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/app/components/page-sections/drive/file-preview", () => ({
  UnifiedMediaDialog: ({ file }: { file: FormattedUserFile }) => (
    <div role="dialog" aria-label="viewer">
      {file.name}
    </div>
  ),
}));
vi.mock("@/app/components/page-sections/drive/DeleteFileConfirmDialog", () => ({
  default: ({ file }: { file: FormattedUserFile | null }) =>
    file ? <div role="alertdialog">Delete {file.name}?</div> : null,
}));

import TrayFileActionHost, { TRAY_RENAME_NOT_ALLOWED } from "../TrayFileActionHost";

function file(overrides: Partial<FormattedUserFile> = {}): FormattedUserFile {
  return {
    name: "report.pdf",
    actualFileName: "Work/report.pdf",
    size: 1,
    createdAt: 1,
    arionHash: "p",
    arionCid: "c",
    fileId: "ab".repeat(32),
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    source: "/Users/me/Docs/Work/report.pdf",
    syncStatus: "synced",
    label: "Docs",
    ...overrides,
  };
}

function mount() {
  const store = createStore();
  render(
    <Provider store={store}>
      <TrayFileActionHost />
    </Provider>,
  );
  return store;
}

async function send(payload: unknown) {
  await waitFor(() => expect(handler).not.toBeNull());
  act(() => handler?.({ payload }));
}

beforeEach(() => {
  handler = null;
  push.mockClear();
  downloadFile.mockClear();
  toastError.mockClear();
  memberLabels = new Set();
  writableLabels = new Set();
});

describe("tray file actions in the main window", () => {
  it("opens the Drive at the file's folder and points at the file", async () => {
    mount();
    await send({ action: "show-in-drive", file: file() });
    expect(push).toHaveBeenCalledWith(
      "/files?openLabel=Docs&openSubfolder=Work&openFile=report.pdf",
    );
  });

  it("opens a drive not synced here as a remote drive", async () => {
    mount();
    await send({ action: "show-in-drive", file: file({ source: "", actualFileName: "a.png", name: "a.png" }) });
    expect(push).toHaveBeenCalledWith("/files?openLabel=Docs&openRemote=1&openFile=a.png");
  });

  it("opens the Drive's Share dialog with the file's drive path", async () => {
    const store = mount();
    const f = file();
    await send({ action: "share", file: f });
    expect(store.get(shareModalFileAtom)).toEqual({ file: f, relativePath: "Work/report.pdf" });
  });

  it("opens the Drive's Rename dialog", async () => {
    const store = mount();
    const f = file();
    await send({ action: "rename", file: f });
    expect(store.get(renameModalFileAtom)).toEqual(f);
  });

  it("refuses Rename in a drive this account can only view, and says why", async () => {
    memberLabels = new Set(["Team"]);
    const store = mount();
    await send({ action: "rename", file: file({ label: "Team" }) });
    expect(store.get(renameModalFileAtom)).toBeNull();
    expect(toastError).toHaveBeenCalledWith(TRAY_RENAME_NOT_ALLOWED);
  });

  it("refuses Rename for a file with no copy here, with the Drive's reason", async () => {
    const store = mount();
    await send({ action: "rename", file: file({ source: "" }) });
    expect(store.get(renameModalFileAtom)).toBeNull();
    expect(toastError).toHaveBeenCalledWith(RENAME_DISABLED_TOOLTIP);
  });

  it("downloads through the Drive's download for the signed-in account", async () => {
    mount();
    const f = file();
    await send({ action: "download", file: f });
    expect(downloadFile).toHaveBeenCalledWith(f, "5Account");
  });

  it("opens the one viewer for View", async () => {
    mount();
    await send({ action: "preview", file: file() });
    expect(screen.getByRole("dialog", { name: "viewer" })).toHaveTextContent("report.pdf");
  });

  it("asks before deleting", async () => {
    mount();
    await send({ action: "delete", file: file() });
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete report.pdf?");
  });

  it("ignores a request it does not understand", async () => {
    const store = mount();
    await send({ action: "format-disk", file: file() });
    await send({ action: "rename", file: null });
    expect(store.get(renameModalFileAtom)).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});
