// File Details must show the Arion BLAKE3 content hash (`arionCid`), never
// the path id (`arionHash`). The footer already existed; these tests pin
// that it reads the right field so a mapping inversion cannot silently
// paint the path id — or "Not yet synced" — over a real digest.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

// The part list is answered per test; every other command (the drive
// membership lookup) gets an empty list.
const ipc = vi.hoisted(() => ({
  parts: [] as string[],
  calls: [] as Array<Record<string, unknown>>,
  pending: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "get_file_part_hashes") return Promise.resolve([]);
    ipc.calls.push(args);
    if (ipc.pending) return new Promise(() => {});
    return Promise.resolve(ipc.parts);
  },
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

const part = (n: number) => n.toString(16).padStart(64, "0");
const BIG = 196_950_000;

describe("FileDetailsPanel file stored in parts", () => {
  beforeEach(() => {
    openUrl.mockReset();
    ipc.parts = [];
    ipc.calls = [];
    ipc.pending = false;
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("does not ask for parts for a file that fits one", () => {
    renderPanel(makeFile({ size: 2048 }));
    expect(ipc.calls).toHaveLength(0);
    expect(screen.getByText("Arion Hash")).toBeInTheDocument();
  });

  it("asks Rust with the drive and the path id, never the content hash", async () => {
    renderPanel(makeFile({ size: BIG }));
    await waitFor(() => expect(ipc.calls).toHaveLength(1));
    expect(ipc.calls[0]).toEqual({
      accountId: "5TestAddress",
      label: "Docs",
      pathHash: PATH_ID,
    });
  });

  it("keeps the single hash while the parts load", () => {
    ipc.pending = true;
    renderPanel(makeFile({ size: BIG }));
    expect(screen.getByText("Arion Hash")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading the file's parts")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /view on file tracker/i }),
    ).toBeInTheDocument();
  });

  it("keeps the single hash when the server lists no parts", async () => {
    ipc.parts = [];
    renderPanel(makeFile({ size: BIG }));
    await waitFor(() => expect(ipc.calls).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByLabelText("Loading the file's parts")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Arion Hash")).toBeInTheDocument();
    expect(screen.queryByTestId("arion-hash-parts")).not.toBeInTheDocument();
  });

  it("lists three or fewer parts without a Show all", async () => {
    ipc.parts = [part(1), part(2), part(3)];
    renderPanel(makeFile({ size: BIG }));
    const list = await screen.findByTestId("arion-hash-parts");
    expect(screen.getByText("Arion Hashes")).toBeInTheDocument();
    expect(screen.getByText("3 parts")).toBeInTheDocument();
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /show all/i })).not.toBeInTheDocument();
  });

  it("shows the first three of many, then every part on Show all", async () => {
    ipc.parts = Array.from({ length: 24 }, (_, i) => part(i + 1));
    renderPanel(makeFile({ size: BIG }));
    const list = await screen.findByTestId("arion-hash-parts");
    expect(screen.getByText("24 parts")).toBeInTheDocument();
    expect(list.querySelectorAll("li")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Show all 24 parts" }));
    expect(screen.getByTestId("arion-hash-parts").querySelectorAll("li")).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getByTestId("arion-hash-parts").querySelectorAll("li")).toHaveLength(3);
  });

  it("copies and opens each part by its own hash", async () => {
    ipc.parts = [part(1), part(2)];
    renderPanel(makeFile({ size: BIG }));
    await screen.findByTestId("arion-hash-parts");

    fireEvent.click(screen.getByTitle("Copy part 2 hash"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(part(2));

    fireEvent.click(screen.getByRole("button", { name: "Open part 2 on File Tracker" }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(`https://hipstats.com/file-tracker/${part(2)}`),
    );
  });

  it("explains how the file is stored, and closes on Escape", async () => {
    ipc.parts = [part(1), part(2)];
    renderPanel(makeFile({ size: BIG }));
    await screen.findByTestId("arion-hash-parts");

    fireEvent.click(screen.getByRole("button", { name: "How your file is stored" }));
    expect(screen.getByRole("dialog", { name: "How your file is stored" })).toHaveTextContent(
      "Files over 8 MB are split into 8 MB parts",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "How your file is stored" })).not.toBeInTheDocument();
  });

  it("opens the explanation on hover and closes it after the pointer leaves", async () => {
    renderPanel(makeFile());
    const icon = screen.getByRole("button", { name: "How your file is stored" });
    fireEvent.mouseEnter(icon);
    const dialog = screen.getByRole("dialog", { name: "How your file is stored" });

    // Moving onto the explanation keeps it open.
    fireEvent.mouseLeave(icon);
    fireEvent.mouseEnter(dialog);
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole("dialog", { name: "How your file is stored" })).toBeInTheDocument();

    fireEvent.mouseLeave(dialog);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "How your file is stored" })).not.toBeInTheDocument(),
    );
  });

  it("opens the explanation on keyboard focus", () => {
    renderPanel(makeFile());
    fireEvent.focus(screen.getByRole("button", { name: "How your file is stored" }));
    expect(screen.getByRole("dialog", { name: "How your file is stored" })).toBeInTheDocument();
  });

  it("keeps a clicked explanation open after the pointer leaves, until clicked again", async () => {
    renderPanel(makeFile());
    const icon = screen.getByRole("button", { name: "How your file is stored" });
    fireEvent.mouseEnter(icon);
    fireEvent.click(icon);
    fireEvent.mouseLeave(icon);
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole("dialog", { name: "How your file is stored" })).toBeInTheDocument();

    fireEvent.click(icon);
    expect(screen.queryByRole("dialog", { name: "How your file is stored" })).not.toBeInTheDocument();
  });

  it("closes the explanation on a click outside", () => {
    renderPanel(makeFile());
    fireEvent.click(screen.getByRole("button", { name: "How your file is stored" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "How your file is stored" })).not.toBeInTheDocument();
  });

  it("opens the File Tracker from the single hash's own text", async () => {
    renderPanel(makeFile());
    const link = screen.getByRole("button", { name: "Open the Arion Hash on File Tracker" });
    expect(link).toHaveAttribute("title", HEX);
    fireEvent.click(link);
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(`https://hipstats.com/file-tracker/${HEX}`),
    );
  });

  it("opens each part's File Tracker page from its hash text and from its arrow", async () => {
    ipc.parts = [part(1), part(2), part(3)];
    renderPanel(makeFile({ size: BIG }));
    await screen.findByTestId("arion-hash-parts");

    const link = screen.getByRole("button", { name: "Open part 3 on File Tracker" });
    expect(link).toHaveAttribute("title", part(3));
    fireEvent.click(link);
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(`https://hipstats.com/file-tracker/${part(3)}`),
    );

    openUrl.mockReset();
    fireEvent.click(screen.getByRole("button", { name: "View part 1 on File Tracker" }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(`https://hipstats.com/file-tracker/${part(1)}`),
    );
  });

  it("explains a single-hash file without mentioning parts", () => {
    renderPanel(makeFile());
    fireEvent.click(screen.getByRole("button", { name: "How your file is stored" }));
    const dialog = screen.getByRole("dialog", { name: "How your file is stored" });
    expect(dialog).toHaveTextContent("Its Arion Hash lets you look it up");
    expect(dialog).not.toHaveTextContent("parts");
  });

  it("offers no explanation while the file has no hash yet", () => {
    renderPanel(makeFile({ arionCid: "" }));
    expect(screen.queryByRole("button", { name: "How your file is stored" })).not.toBeInTheDocument();
  });
});
