// The Shared Drives page: what "Shared by Me" lists and how it marks it,
// that it never claims "nothing shared" before the sharing is known, and the
// one-dialog-at-a-time path from "Share a drive" through a new drive to its
// Share dialog. The picker, the folder dialog and "Shared with Me" are
// stubbed: each has its own tests, and here only the page's wiring of them
// is the question.

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

import { shareDialogAtom, shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/shared-drives",
}));

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Grwva" }),
}));

const requireUploadRoom = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/hooks/useCreditCheck", () => ({
  useCreditCheck: () => ({ requireUploadRoom }),
}));

const folders = vi.hoisted(() => ({
  value: { local: [] as unknown[], remote: [] as unknown[] },
}));
vi.mock("@/app/lib/tauri/syncFolders", () => ({
  fetchSyncFoldersWithStats: vi.fn(async () => folders.value),
}));

const sharing = vi.hoisted(() => ({
  byLabel: new Map<string, DriveSharing>(),
  isPending: false,
}));
vi.mock("@/app/lib/hooks/useOwnedDriveSharing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/hooks/useOwnedDriveSharing")>()),
  useOwnedDriveSharingState: () => sharing,
}));

// The real menu is Radix-backed and does not open under jsdom.
vi.mock("@/components/ui/alt-table/TableActionMenu", () => ({
  __esModule: true,
  default: ({ items, children }: { items: { itemTitle: React.ReactNode; onItemClick?: () => void }[]; children: React.ReactNode }) => (
    <div>
      {children}
      {items.map((item, i) => (
        <button key={i} type="button" className="action-menu-area" onClick={() => item.onItemClick?.()}>
          {item.itemTitle}
        </button>
      ))}
    </div>
  ),
}));

// The picker's own Continue/close rules are tested with it. Here it is only
// the way to "Sync a Folder", which the real one reaches after closing itself.
vi.mock("@/components/page-sections/drive/share-drive-picker/ShareDriveFlow", () => ({
  __esModule: true,
  default: ({ drives, onClose, onAddDrive }: { drives: string[]; onClose: () => void; onAddDrive: () => void }) => (
    <div role="dialog" aria-label="Share a drive picker">
      <span data-testid="picker-drives">{drives.join(",")}</span>
      <button
        type="button"
        onClick={() => {
          onClose();
          onAddDrive();
        }}
      >
        Picker new drive
      </button>
    </div>
  ),
}));

vi.mock("@/components/page-sections/settings/AddLocalFolderDialog", () => ({
  AddLocalFolderDialog: ({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: (label?: string) => void }) =>
    open ? (
      <div role="dialog" aria-label="Add folder dialog">
        <button
          type="button"
          onClick={() => {
            onSuccess("Launch");
            onClose();
          }}
        >
          Folder added
        </button>
      </div>
    ) : null,
}));

const withMeProps = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("@/components/page-sections/settings/multi-folder-sync", () => ({
  SharedWithMeSection: (props: Record<string, unknown>) => {
    withMeProps.value = props;
    return <section aria-label={String(props.label)} />;
  },
}));

import SharedDrivesView, { SHARED_BY_ME_LABEL, SHARED_WITH_ME_LABEL } from "../SharedDrivesView";
import { SHARE_A_DRIVE_EMPTY_TITLE as SHARED_BY_ME_EMPTY_TITLE } from "../ShareADriveEmptyState";

const local = (name: string, ownerSs58?: string) => ({
  id: name,
  folderName: name,
  localPath: `/Users/me/${name}`,
  isLocal: true,
  status: "syncing",
  lastModified: 1,
  ownerSs58,
});

function renderPage() {
  const store = createStore();
  const utils = render(
    <Provider store={store}>
      <SharedDrivesView />
    </Provider>,
  );
  return { store, ...utils };
}

beforeEach(() => {
  push.mockReset();
  requireUploadRoom.mockClear();
  folders.value = { local: [], remote: [] };
  sharing.byLabel = new Map();
  sharing.isPending = false;
  withMeProps.value = null;
});

describe("Shared by Me", () => {
  it("lists only this account's drives that are shared, each marked Owner", async () => {
    folders.value = {
      local: [local("Team"), local("Private"), local("Theirs", OWNER)],
      remote: [],
    };
    sharing.byLabel = new Map([
      ["Team", { memberCount: 3, liveInviteCount: 0, totalInviteCount: 0 }],
      ["Private", { memberCount: 0, liveInviteCount: 0, totalInviteCount: 0 }],
    ]);
    renderPage();

    expect(await screen.findByText("Team")).toBeInTheDocument();
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
    expect(screen.queryByText("Theirs")).not.toBeInTheDocument();
    expect(screen.getByText("Owner")).toHaveAttribute("title", "You own this drive");
    expect(screen.getByText("Shared with 3")).toBeInTheDocument();
    expect(screen.getByText(SHARED_BY_ME_LABEL)).toBeInTheDocument();
  });

  it("does not say nothing is shared while the sharing is still on its way", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.isPending = true;
    renderPage();
    await waitFor(() => expect(withMeProps.value).not.toBeNull());
    expect(screen.queryByText(SHARED_BY_ME_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("says so, and offers Share a drive, once nothing turns out to be shared", async () => {
    folders.value = { local: [local("Private")], remote: [] };
    renderPage();
    expect(await screen.findByText(SHARED_BY_ME_EMPTY_TITLE)).toBeInTheDocument();
  });

  it("opens a shared drive on the Drive page, and its access from the row", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", { memberCount: 2, liveInviteCount: 0, totalInviteCount: 0 }]]);
    const { store } = renderPage();

    fireEvent.click(await screen.findByText("Team"));
    expect(push).toHaveBeenCalledWith("/files?openLabel=Team");

    // The inline button and the menu item open the same panel.
    fireEvent.click(screen.getAllByRole("button", { name: "Manage access" })[0]!);
    expect(store.get(shareDriveModalAtom)).toEqual({ label: "Team", folderName: "Team" });

    fireEvent.click(screen.getByRole("button", { name: "Share drive…" }));
    expect(store.get(shareDialogAtom)).toEqual({ label: "Team", folderName: "Team" });
  });
});

describe("Share a drive", () => {
  it("offers the account's own drives only", async () => {
    folders.value = { local: [local("Mine"), local("Theirs", OWNER)], remote: [] };
    renderPage();
    await screen.findByText(SHARED_BY_ME_EMPTY_TITLE);
    fireEvent.click(screen.getAllByRole("button", { name: "Share a drive" })[0]!);
    expect(screen.getByTestId("picker-drives")).toHaveTextContent(/^Mine$/);
  });

  it("goes from a new drive to its Share dialog, one dialog at a time", async () => {
    const { store } = renderPage();
    await screen.findByText(SHARED_BY_ME_EMPTY_TITLE);

    fireEvent.click(screen.getAllByRole("button", { name: "Share a drive" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Picker new drive" }));
    // The storage gate first, as the Drive page's Sync a Folder.
    await waitFor(() => expect(requireUploadRoom).toHaveBeenCalledWith("folder-sync", false));
    expect(screen.queryByRole("dialog", { name: "Share a drive picker" })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Add folder dialog" })).toBeInTheDocument();
    expect(store.get(shareDialogAtom)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Folder added" }));
    });
    expect(screen.queryByRole("dialog", { name: "Add folder dialog" })).not.toBeInTheDocument();
    expect(store.get(shareDialogAtom)).toEqual({ label: "Launch", folderName: "Launch" });
  });

  it("opens nothing when the storage gate refuses", async () => {
    requireUploadRoom.mockResolvedValueOnce(false);
    renderPage();
    await screen.findByText(SHARED_BY_ME_EMPTY_TITLE);
    fireEvent.click(screen.getAllByRole("button", { name: "Share a drive" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Picker new drive" }));
    await waitFor(() => expect(requireUploadRoom).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Add folder dialog" })).not.toBeInTheDocument();
  });
});

describe("Shared with Me", () => {
  it("is always on the page, under its own heading and empty text", async () => {
    renderPage();
    await waitFor(() => expect(withMeProps.value).not.toBeNull());
    expect(withMeProps.value).toMatchObject({ label: SHARED_WITH_ME_LABEL, alwaysShow: true });
    expect(withMeProps.value!.emptyState).toBeTruthy();
    // Sharing starts in "Shared by Me": no second Share a drive button here.
    expect(withMeProps.value!.onShareDrive).toBeUndefined();
  });

  it("opens a joined drive on the Drive page by its browse label and name", async () => {
    renderPage();
    await waitFor(() => expect(withMeProps.value).not.toBeNull());
    const open = withMeProps.value!.onOpenDrive as (identity: object) => void;
    open({ ownerSs58: OWNER, folderHash: "ab".repeat(8), displayLabel: "Design" });
    const url = new URL(`app://x${push.mock.calls[0]![0]}`);
    expect(url.searchParams.get("openName")).toBe("Design");
    expect(url.searchParams.get("openRemote")).toBe("1");
    expect(url.searchParams.get("openLabel")).toContain(OWNER);
  });
});
