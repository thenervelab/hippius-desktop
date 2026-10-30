// Right-click "Copy link": offered only for a file or folder that already has
// a live link, directly above Share via link, and it copies that link.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Me" }),
}));
vi.mock("@/app/utils/hooks/useUrlParams", () => ({
  useUrlParams: () => ({ getParam: () => null }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks/useSharedDriveRoles")>();
  const empty = new Set<string>();
  return {
    ...actual,
    useMemberDriveLabels: () => empty,
    useWritableMemberDriveLabels: () => empty,
    useManageableMemberDriveLabels: () => empty,
  };
});
const lookups = vi.hoisted(() => ({ linkFor: vi.fn() }));
vi.mock("@/app/components/page-sections/drive/useExistingLinks", () => ({
  useExistingLinks: () => ({ linkFor: lookups.linkFor, isLoadingFor: () => false }),
}));
const copy = vi.hoisted(() => vi.fn());
vi.mock("@/app/components/page-sections/drive/useCopyExistingLink", () => ({
  useCopyExistingLink: () => copy,
}));

import FileContextMenu from "../index";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const FILE = {
  name: "Shot.png",
  actualFileName: "Shot.png",
  label: "Captures",
  isFolder: false,
  syncStatus: "synced",
  isAssigned: true,
  source: "/x/Shot.png",
} as FormattedUserFile;

const LINK = { state: "ready", url: "https://x/s/t#k=K", kind: "file" };

function open(file: FormattedUserFile, basePath: string | null = null) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { shares: true, folder_shares: true } as never);
  const onClose = vi.fn();
  render(
    <Provider store={store}>
      <FileContextMenu
        x={10}
        y={10}
        file={file}
        onClose={onClose}
        onFileDownload={() => {}}
        onShareFile={() => {}}
        basePath={basePath}
      />
    </Provider>,
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("right-click Copy link", () => {
  it("is not offered for a file with no link", () => {
    lookups.linkFor.mockReturnValue(null);
    open(FILE);
    expect(screen.getByText("Share via link")).toBeInTheDocument();
    expect(screen.queryByText("Copy link")).toBeNull();
  });

  it("sits directly above Share via link and copies the existing link", () => {
    lookups.linkFor.mockReturnValue(LINK);
    const onClose = open(FILE, "Shots");
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels.indexOf("Copy link")).toBe(labels.indexOf("Share via link") - 1);
    // Looked up under the path the row's link icon uses.
    expect(lookups.linkFor).toHaveBeenCalledWith(FILE, "Shots/Shot.png");
    fireEvent.click(screen.getByText("Copy link"));
    expect(copy).toHaveBeenCalledWith(LINK, { file: FILE, relativePath: "Shots/Shot.png" });
    expect(onClose).toHaveBeenCalled();
  });

  it("reads Unlock to copy link while the key waits on an unlock", () => {
    lookups.linkFor.mockReturnValue({ ...LINK, state: "locked", url: null });
    open(FILE);
    expect(screen.getByText("Unlock to copy link")).toBeInTheDocument();
  });

  it("is offered for a folder with a live folder link", () => {
    lookups.linkFor.mockReturnValue({ ...LINK, kind: "folder" });
    const folder = { name: "Trips", actualFileName: "Trips", label: "Drive", isFolder: true } as FormattedUserFile;
    open(folder, "Work");
    expect(lookups.linkFor).toHaveBeenCalledWith(folder, "Work/Trips");
    expect(screen.getByText("Copy link")).toBeInTheDocument();
  });
});
