import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, configure } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import {
  insightsSheetAtom,
  serverCapabilitiesAtom,
  shareModalFileAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";
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
  UnifiedMediaDialog: ({
    file,
    allFiles,
    onNavigate,
  }: {
    file: FormattedUserFile;
    allFiles: FormattedUserFile[];
    onNavigate: (f: FormattedUserFile) => void;
  }) => (
    <div role="dialog" aria-label="viewer">
      <span data-testid="viewer-file">{file.name}</span>
      <ul aria-label="viewer list">
        {allFiles.map((f) => (
          <li key={f.name}>
            <button type="button" onClick={() => onNavigate(f)}>
              {f.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ),
}));
vi.mock("@/app/components/page-sections/drive/DeleteFileConfirmDialog", () => ({
  default: ({ file }: { file: FormattedUserFile | null }) =>
    file ? <div role="alertdialog">Delete {file.name}?</div> : null,
}));

import TrayFileActionHost, { TRAY_INSIGHTS_UNAVAILABLE, TRAY_RENAME_NOT_ALLOWED } from "../TrayFileActionHost";

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

function mount(caps: ServerCapabilities | null = null) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps);
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

  it("opens the Captures page at a capture with its Insights panel, before any link is known", async () => {
    const store = mount({ shares: true, share_insights: true } as ServerCapabilities);
    const capture = file({
      name: "Recording 1.mp4",
      actualFileName: "Recording 1.mp4",
      label: "Hippius Captures",
      source: "/Users/me/hippius-recording/Recording 1.mp4",
    });
    await send({ action: "insights", file: capture });
    expect(push).toHaveBeenCalledWith("/captures?openLabel=Hippius+Captures&openFile=Recording+1.mp4");
    // The panel finds the newest link in the listing, or offers to make one.
    expect(store.get(insightsSheetAtom)).toEqual({
      shareToken: null,
      fileName: "Recording 1.mp4",
      file: capture,
      capture: { label: "Hippius Captures", relativePath: "Recording 1.mp4", fileId: null },
    });
  });

  it("opens a capture kept in a folder of another drive where Show in Hippius would", async () => {
    const store = mount({ shares: true, share_insights: true } as ServerCapabilities);
    const capture = file({ name: "Shot.png", actualFileName: "Captures/Shot.png", source: "/Users/me/Docs/Captures/Shot.png" });
    await send({ action: "insights", file: capture });
    expect(push).toHaveBeenCalledWith("/files?openLabel=Docs&openSubfolder=Captures&openFile=Shot.png");
    expect(store.get(insightsSheetAtom)?.capture).toEqual({ label: "Docs", relativePath: "Captures/Shot.png", fileId: null });
  });

  it("says Insights are unavailable on a server without them, and opens nothing", async () => {
    const store = mount({ shares: true } as ServerCapabilities);
    await send({ action: "insights", file: file({ name: "a.png", actualFileName: "a.png" }) });
    expect(toastError).toHaveBeenCalledWith(TRAY_INSIGHTS_UNAVAILABLE);
    expect(push).not.toHaveBeenCalled();
    expect(store.get(insightsSheetAtom)).toBeNull();
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

  it("walks the popover tab the file was opened from", async () => {
    mount();
    const a = file({ name: "a.png", actualFileName: "a.png" });
    const b = file({ name: "b.png", actualFileName: "b.png" });
    await send({ action: "preview", file: b, siblings: [a, b] });
    expect(screen.getByTestId("viewer-file")).toHaveTextContent("b.png");
    const list = screen.getByRole("list", { name: "viewer list" });
    expect(list).toHaveTextContent("a.png");
    expect(list).toHaveTextContent("b.png");
    // Moving to another file keeps the same list.
    act(() => screen.getByRole("button", { name: "a.png" }).click());
    expect(screen.getByTestId("viewer-file")).toHaveTextContent("a.png");
    expect(screen.getByRole("list", { name: "viewer list" })).toHaveTextContent("b.png");
  });

  it("shows the file alone when the list it came with does not hold it", async () => {
    mount();
    const a = file({ name: "a.png", actualFileName: "a.png" });
    await send({ action: "preview", file: file(), siblings: [a] });
    const list = screen.getByRole("list", { name: "viewer list" });
    expect(list).toHaveTextContent("report.pdf");
    expect(list).not.toHaveTextContent("a.png");
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
