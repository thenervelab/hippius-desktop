// A row browsed from the server (no copy on this computer) gets its Delete
// item only while the server has Trash, where Rust trashes it on Hippius.
// With Trash off it has none: today's delete removes a local copy it lacks.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import React from "react";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { deleteRulesAtom, offersDeleteOnRow } from "@/app/lib/trash/deleteMode";

const h = vi.hoisted(() => ({ writable: new Set<string>(), members: new Set<string>() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/app/lib/wallet-auth-context", () => ({ useWalletAuth: () => ({ polkadotAddress: "5Me" }) }));
vi.mock("@/app/utils/hooks/useUrlParams", () => ({ useUrlParams: () => ({ getParam: () => null }) }));
vi.mock("@/app/components/page-sections/drive/driveRoute", () => ({
  useDriveRoute: () => ({ basePath: "/files" }),
  pageFolderHref: () => null,
}));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", () => ({
  useMemberDriveLabels: () => h.members,
  useWritableMemberDriveLabels: () => h.writable,
  useManageableMemberDriveLabels: () => new Set<string>(),
  useFolderShareInviteOffered: () => false,
}));
vi.mock("@/app/components/page-sections/drive/useExistingLinks", () => ({ useExistingLinks: () => ({ linkFor: () => null }) }));
vi.mock("@/app/components/page-sections/drive/useCopyExistingLink", () => ({ useCopyExistingLink: () => () => {} }));
vi.mock("@/app/components/page-sections/drive/move/DriveMoveProvider", () => ({ useDriveMove: () => null }));
vi.mock("@/app/components/page-sections/drive/useCaptureInsightsItem", () => ({ useFileInsightsItem: () => () => [] }));
vi.mock("@/app/lib/starred/useStars", () => ({
  useStars: () => ({ isStarred: () => false, toggleRow: vi.fn() }),
}));

import FileContextMenu from "../index";

/** A file in a drive browsed from the server: an id, no local path. */
const REMOTE_FILE = {
  name: "report.pdf",
  actualFileName: "Work/report.pdf",
  fileId: "ab".repeat(32),
  label: "archive",
  isAssigned: true,
  remoteDriveLabel: "archive",
} as FormattedUserFile;

/** A folder there: the `remote://` source, its name, where it was listed. */
const REMOTE_FOLDER = {
  name: "Trip",
  actualFileName: "Trip",
  source: "remote://archive",
  label: "archive",
  isAssigned: true,
  isFolder: true,
  parentRelativePath: "Work",
} as FormattedUserFile;

const SYNCED_FILE = {
  name: "notes.txt",
  actualFileName: "notes.txt",
  source: "/Users/me/docs/notes.txt",
  label: "docs",
  isAssigned: true,
} as FormattedUserFile;

function renderMenu(file: FormattedUserFile, trash: boolean, canDeleteForever = true) {
  const store = createStore();
  store.set(serverCapabilitiesAtom, { drive_trash: trash } as never);
  store.set(deleteRulesAtom, {
    address: "5Me",
    skipTrash: false,
    drives: [{ label: file.label ?? "default", canDeleteForever, skipsTrash: false }],
    at: Date.now(),
  });
  render(
    <Provider store={store}>
      <FileContextMenu x={0} y={0} file={file} onClose={() => {}} onDelete={() => {}} onFileDownload={() => {}} />
    </Provider>,
  );
}

describe("Delete on a row browsed from the server", () => {
  it.each([
    ["a file", REMOTE_FILE],
    ["a folder", REMOTE_FOLDER],
  ])("offers Move to Trash on %s while the server has Trash", (_, file) => {
    renderMenu(file, true);
    expect(screen.getByText("Move to Trash")).toBeInTheDocument();
  });

  it.each([
    ["a file", REMOTE_FILE],
    ["a folder", REMOTE_FOLDER],
  ])("offers no delete on %s with Trash off", (_, file) => {
    renderMenu(file, false);
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Move to Trash")).toBeNull();
  });

  it("keeps today's Delete on a synced row with Trash off", () => {
    renderMenu(SYNCED_FILE, false);
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("offers nothing in a drive this account can only view", () => {
    const viewOnly = { ...REMOTE_FILE, label: "shared:5Owner~0123456789abcdef" } as FormattedUserFile;
    renderMenu(viewOnly, true, false);
    expect(screen.queryByText("Move to Trash")).toBeNull();
  });
});

describe("offersDeleteOnRow", () => {
  it("never offers a delete on a whole drive", () => {
    const drive = { ...REMOTE_FOLDER, isDriveRoot: true } as FormattedUserFile;
    expect(offersDeleteOnRow(drive, true, true)).toBe(false);
  });

  it("counts a search hit not downloaded here as browsed from the server", () => {
    const pending = { ...SYNCED_FILE, fileId: "cd".repeat(32), syncStatus: "pending" } as FormattedUserFile;
    expect(offersDeleteOnRow(pending, false, true)).toBe(false);
    expect(offersDeleteOnRow(pending, true, true)).toBe(true);
    expect(offersDeleteOnRow(pending, true, false)).toBe(false);
  });
});
