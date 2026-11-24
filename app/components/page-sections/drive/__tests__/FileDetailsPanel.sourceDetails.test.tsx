// The details panel's extra rows from the file's upload origin: Date Taken
// and Date Modified after Date Uploaded, Camera and Uploaded from after File
// Size, each only when Rust has a value. The rows already there paint first;
// a failed lookup adds nothing; a folder never asks.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { FileSourceDetails } from "@/app/lib/tauri/devices";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5TestAddress" }),
}));

vi.mock("@/app/lib/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks")>();
  return {
    ...actual,
    useBreakpoint: () => ({
      breakpoint: "xl",
      isMobile: false,
      isTablet: false,
      isLaptop: false,
      isDesktop: true,
      isLargeDesktop: false,
    }),
  };
});

vi.mock("@/app/lib/hooks/useDriveSharing", () => ({
  useDriveSharing: () => ({
    isShared: false,
    canManage: false,
    sharing: { isShared: false, direction: null, label: null, title: null },
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import FileDetailsPanel from "../FileDetailsPanel";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import { formatCompactDate } from "@/app/lib/utils/dateUtils";

const PATH_ID = "ab".repeat(32);
const TAKEN = Math.floor(new Date(1995, 5, 14, 9, 30).getTime() / 1000);
const MODIFIED = Math.floor(new Date(2026, 10, 2, 18, 5).getTime() / 1000);

function makeFile(overrides: Partial<FormattedUserFile> = {}): FormattedUserFile {
  return {
    name: "IMG_0001.HEIC",
    actualFileName: "Camera/IMG_0001.HEIC",
    size: 2048,
    createdAt: 1_700_000_000_000,
    arionHash: PATH_ID,
    arionCid: "cd".repeat(32),
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 1_700_000_000_000,
    isFolder: false,
    type: "private",
    isErasureCoded: false,
    mainReqHash: "",
    source: "/Users/me/Photos/Camera/IMG_0001.HEIC",
    label: "Photos",
    syncStatus: "synced",
    ...overrides,
  };
}

function renderPanel(file: FormattedUserFile) {
  const store = createStore();
  store.set(fileDetailsPanelAtom, file);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Provider store={store}>
        <FileDetailsPanel />
      </Provider>
    </QueryClientProvider>,
  );
}

const ROW_LABELS = /^(File Name|File Type|Date Uploaded|Date Taken|Date Modified|File Size|Camera|Uploaded from|Sync Folder)$/;

function rowOrder(): string[] {
  return screen.getAllByText(ROW_LABELS).map((el) => el.textContent ?? "");
}

function sourceCalls() {
  return tauri.core.invoke.mock.calls.filter(([command]) => command === "get_file_source_details");
}

beforeEach(() => {
  tauri.reset();
  // The panel's other lookups (drive memberships) are not under test here:
  // left pending, so they neither answer nor log.
  tauri.setInvokeFallback(() => new Promise(() => {}));
});

describe("FileDetailsPanel source details", () => {
  it("adds every row Rust answers, in their places", async () => {
    tauri.onInvoke("get_file_source_details", (): FileSourceDetails => ({
      takenAt: TAKEN,
      modifiedAt: MODIFIED,
      camera: "Apple iPhone 15 Pro Max",
      uploadedFrom: "Ada's iPhone",
    }));
    renderPanel(makeFile());

    expect(await screen.findByText("Apple iPhone 15 Pro Max")).toBeInTheDocument();
    expect(screen.getByText("Ada's iPhone")).toBeInTheDocument();
    // A 1995 scan is a real date, not a dash.
    expect(screen.getByText(formatCompactDate(new Date(TAKEN * 1000)))).toBeInTheDocument();
    expect(screen.getByText(formatCompactDate(new Date(MODIFIED * 1000)))).toBeInTheDocument();
    expect(rowOrder()).toEqual([
      "File Name",
      "File Type",
      "Date Uploaded",
      "Date Taken",
      "Date Modified",
      "File Size",
      "Camera",
      "Uploaded from",
      "Sync Folder",
    ]);
    expect(sourceCalls()).toEqual([
      ["get_file_source_details", { accountId: "5TestAddress", target: { label: "Photos", fileId: PATH_ID } }],
    ]);
  });

  it("shows only the rows that have a value", async () => {
    tauri.onInvoke("get_file_source_details", (): FileSourceDetails => ({
      takenAt: null,
      modifiedAt: MODIFIED,
      camera: "Canon EOS R5",
      uploadedFrom: null,
    }));
    renderPanel(makeFile());

    expect(await screen.findByText("Canon EOS R5")).toBeInTheDocument();
    expect(rowOrder()).toEqual([
      "File Name",
      "File Type",
      "Date Uploaded",
      "Date Modified",
      "File Size",
      "Camera",
      "Sync Folder",
    ]);
  });

  it("paints the existing rows at once and adds nothing when the lookup fails", async () => {
    let fail: (error: unknown) => void = () => {};
    tauri.onInvoke("get_file_source_details", () => new Promise((_, reject) => (fail = reject)));
    renderPanel(makeFile());

    expect(screen.getByText("Date Uploaded")).toBeInTheDocument();
    expect(screen.getByText("File Size")).toBeInTheDocument();
    fail({ kind: "Other", message: "no" });
    await vi.waitFor(() => expect(sourceCalls()).toHaveLength(1));
    // Let the rejection settle before checking nothing was added.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Date Taken")).not.toBeInTheDocument();
    expect(screen.queryByText("Camera")).not.toBeInTheDocument();
    expect(screen.queryByText("Uploaded from")).not.toBeInTheDocument();
  });

  it("asks under the browsed drive's label and the cloud file id for a server-only row", async () => {
    tauri.onInvoke("get_file_source_details", (): FileSourceDetails => ({
      takenAt: null,
      modifiedAt: null,
      camera: null,
      uploadedFrom: "Pixel 8",
    }));
    const fileId = "ef".repeat(32);
    renderPanel(
      makeFile({
        source: undefined,
        arionHash: fileId,
        fileId,
        label: "shared:5Owner~0123456789abcdef",
        remoteDriveLabel: "shared:5Owner~0123456789abcdef",
      }),
    );
    expect(await screen.findByText("Pixel 8")).toBeInTheDocument();
    expect(sourceCalls()[0][1]).toEqual({
      accountId: "5TestAddress",
      target: { label: "shared:5Owner~0123456789abcdef", fileId },
    });
  });

  it("never asks for a folder", async () => {
    tauri.onInvoke("get_file_source_details", () => ({ takenAt: TAKEN, modifiedAt: null, camera: "X", uploadedFrom: null }));
    renderPanel(makeFile({ isFolder: true, name: "Camera", arionHash: "" }));
    expect(screen.getByText("Folder Details")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(sourceCalls()).toHaveLength(0);
    expect(screen.queryByText("Date Taken")).not.toBeInTheDocument();
  });

  it("never asks for a file still uploading or with no server id yet", async () => {
    tauri.onInvoke("get_file_source_details", () => ({ takenAt: TAKEN, modifiedAt: null, camera: "X", uploadedFrom: null }));
    const { unmount } = renderPanel(makeFile({ syncStatus: "uploading" }));
    await new Promise((r) => setTimeout(r, 0));
    unmount();
    renderPanel(makeFile({ arionHash: "", fileId: undefined }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sourceCalls()).toHaveLength(0);
  });
});
