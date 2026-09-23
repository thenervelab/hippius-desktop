// File Details must show the Arion BLAKE3 content hash (`arionCid`), never
// the path id (`arionHash`). The footer already existed; these tests pin
// that it reads the right field so a mapping inversion cannot silently
// paint the path id — or "Not yet synced" — over a real digest.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import FileDetailsPanel from "../FileDetailsPanel";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PATH_ID =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

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

const driveSharing = vi.hoisted(() => ({ isShared: false }));
vi.mock("@/app/lib/hooks/useDriveSharing", () => ({
  useDriveSharing: () => ({
    isShared: driveSharing.isShared,
    canManage: false,
    sharing: { isShared: driveSharing.isShared, direction: null, label: null, title: null },
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeFile(overrides: Partial<FormattedUserFile> = {}): FormattedUserFile {
  return {
    name: "report.pdf",
    actualFileName: "Work/report.pdf",
    size: 2048,
    createdAt: 1_700_000_000_000,
    arionHash: PATH_ID,
    arionCid: HEX,
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 1_700_000_000_000,
    isFolder: false,
    type: "private",
    isErasureCoded: false,
    mainReqHash: "",
    source: "/Users/me/Docs/Work/report.pdf",
    label: "Docs",
    syncStatus: "synced",
    ...overrides,
  };
}

function renderPanel(file: FormattedUserFile | null) {
  const store = createStore();
  store.set(fileDetailsPanelAtom, file);
  // The panel asks whether the file's drive is shared, to decide whether
  // attribution is worth showing, so it reads the query client.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>
        <FileDetailsPanel />
      </Provider>
    </QueryClientProvider>,
  );
}

describe("FileDetailsPanel Arion hash", () => {
  beforeEach(() => {
    openUrl.mockReset();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("copies the content hash, not the path id", () => {
    renderPanel(makeFile());

    expect(screen.getByText("Arion Hash")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Copy Arion Hash"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(HEX);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(PATH_ID);
  });

  it("opens File Tracker with the content hash", async () => {
    renderPanel(makeFile());

    fireEvent.click(screen.getByRole("button", { name: /view on file tracker/i }));
    expect(openUrl).toHaveBeenCalledWith(
      `https://hipstats.com/file-tracker/${HEX}`,
    );
  });

  it("says not yet synced when the content hash is missing, even if a path id is present", () => {
    renderPanel(makeFile({ arionCid: "", arionHash: PATH_ID }));

    expect(screen.getByText("Not yet synced")).toBeInTheDocument();
    expect(screen.queryByTitle("Copy Arion Hash")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /view on file tracker/i }),
    ).not.toBeInTheDocument();
  });

  it("omits the Arion Hash footer for folders", () => {
    renderPanel(makeFile({ isFolder: true, name: "Photos", arionCid: HEX }));

    expect(screen.getByText("Folder Details")).toBeInTheDocument();
    expect(screen.queryByText("Arion Hash")).not.toBeInTheDocument();
  });
});

describe("FileDetailsPanel upload attribution", () => {
  beforeEach(() => {
    driveSharing.isShared = false;
  });

  // On a solo drive every file was uploaded by the reader, so the row would
  // say nothing and cost a line on every file they open.
  it("stays quiet on a drive that is not shared", () => {
    driveSharing.isShared = false;
    renderPanel(makeFile({ uploadedBy: "5Someone" }));
    expect(screen.queryByText("Added by")).not.toBeInTheDocument();
  });

  it("names the uploader on a shared drive", () => {
    driveSharing.isShared = true;
    renderPanel(makeFile({ uploadedBy: "5SomeoneElseEntirely1234567890" }));
    expect(screen.getByText("Added by")).toBeInTheDocument();
  });

  // An ss58 the reader has to compare against their own is not an answer.
  it("says You rather than making the reader match their own address", () => {
    driveSharing.isShared = true;
    renderPanel(makeFile({ uploadedBy: "5TestAddress" }));
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  // The server attributes rows it can; older rows and admin writes have none.
  // File Details still shows the row — UploaderCell falls back to Owner.
  it("falls back to Owner when the server never attributed the file", () => {
    driveSharing.isShared = true;
    renderPanel(makeFile({ uploadedBy: undefined }));
    expect(screen.getByText("Added by")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("stays quiet on a folder, which nobody uploaded", () => {
    driveSharing.isShared = true;
    renderPanel(makeFile({ isFolder: true, uploadedBy: "5Someone" }));
    expect(screen.queryByText("Added by")).not.toBeInTheDocument();
  });
});
