// Right-click "View insights": every file in every drive (never a folder),
// right after Share via link, once the server has Insights. It opens the
// Insights panel on the file's newest link, or on "Create link" without one.
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
vi.mock("@/app/components/page-sections/drive/useExistingLinks", () => ({
  useExistingLinks: () => ({ linkFor: () => null, isLoadingFor: () => false }),
}));
vi.mock("@/app/components/page-sections/drive/useCopyExistingLink", () => ({
  useCopyExistingLink: () => vi.fn(),
}));
const listing = vi.hoisted(() => ({
  rows: new Map<string, { shareToken: string; createdAt: string }[]>(),
}));
vi.mock("@/app/lib/hooks/useSharedFiles", () => ({
  useSharedFiles: () => ({
    getSharesFor: (label: string, path: string) => listing.rows.get(`${label}/${path}`) ?? [],
    getUnplacedSharesNamed: () => [],
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));

import FileContextMenu from "../index";
import { insightsSheetAtom, serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const PDF = {
  name: "report.pdf",
  actualFileName: "Work/report.pdf",
  label: "My Drive",
  isFolder: false,
  syncStatus: "synced",
  isAssigned: true,
  source: "/x/Work/report.pdf",
  size: 1200,
} as FormattedUserFile;

function open(file: FormattedUserFile, caps: Record<string, boolean> = { shares: true, share_insights: true }) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, caps as never);
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
        basePath="Work"
      />
    </Provider>,
  );
  return { store, onClose };
}

function itemLabels(): string[] {
  return screen.getAllByRole("button").map((b) => b.textContent ?? "");
}

beforeEach(() => {
  listing.rows.clear();
});

describe("right-click View insights", () => {
  it("is offered for any file, right after Share via link", () => {
    open(PDF);
    const labels = itemLabels();
    const share = labels.indexOf("Share via link");
    expect(share).toBeGreaterThanOrEqual(0);
    expect(labels[share + 1]).toBe("View insights");
  });

  it("opens the panel on Create link for a file with no link, and closes the menu", () => {
    const { store, onClose } = open(PDF);
    fireEvent.click(screen.getByText("View insights"));
    expect(store.get(insightsSheetAtom)).toMatchObject({
      shareToken: null,
      fileName: "Work/report.pdf",
      capture: { label: "My Drive", relativePath: "Work/report.pdf", size: 1200 },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("opens the file's newest link when it has one", () => {
    listing.rows.set("My Drive/Work/report.pdf", [
      { shareToken: "old", createdAt: "2026-10-01T10:00:00Z" },
      { shareToken: "new", createdAt: "2026-11-01T10:00:00Z" },
    ]);
    const { store } = open(PDF);
    fireEvent.click(screen.getByText("View insights"));
    expect(store.get(insightsSheetAtom)?.shareToken).toBe("new");
  });

  it("is offered for a file that has not finished uploading, where Share via link is not", () => {
    open({ ...PDF, syncStatus: "uploading" } as FormattedUserFile);
    expect(screen.queryByText("Share via link")).toBeNull();
    expect(screen.getByText("View insights")).toBeInTheDocument();
  });

  it("is not offered for a folder or on a server without Insights", () => {
    open({ ...PDF, isFolder: true, name: "Work", actualFileName: "Work" } as FormattedUserFile);
    expect(screen.queryByText("View insights")).toBeNull();
  });

  it("is not offered on a server without Insights", () => {
    open(PDF, { shares: true });
    expect(screen.queryByText("View insights")).toBeNull();
  });
});
