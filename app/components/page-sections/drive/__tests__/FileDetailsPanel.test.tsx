// File Details must show the Arion BLAKE3 content hash (`arionCid`), never
// the path id (`arionHash`). The footer already existed; these tests pin
// that it reads the right field so a mapping inversion cannot silently
// paint the path id — or "Not yet synced" — over a real digest.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

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
  return render(
    <Provider store={store}>
      <FileDetailsPanel />
    </Provider>,
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
