// The Shared Drives page: one list of your own shared drives and the ones
// shared with you, narrowed by underline tabs when there are both, with the
// total size and file count of what the list shows; it never claims
// "nothing shared" before both kinds are known; it pages the list as one;
// and "Share a drive" in the page header takes the one-dialog-at-a-time path
// from the picker through a new drive to its Share dialog. The picker, the
// folder dialog and "Shared with me"'s rows are stubbed: each has its own
// tests, and here only the page's wiring of them is the question.

import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

import { shareDialogAtom, shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import type { DriveMembershipInfo, MyFolderGrantInfo, SharedDriveStats } from "@/app/lib/tauri/sharedDrives";
import type { FolderGrantStatsState } from "@/app/lib/hooks/useFolderGrantStats";
import type { SharedWithMeData } from "@/components/page-sections/settings/multi-folder-sync/sharedWithMeState";

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const GB = 1_000_000_000;

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

// What the page reads about the drives shared with this account.
const withMe = vi.hoisted(() => ({
  data: { kind: "ready", memberships: [] } as SharedWithMeData,
  grants: [] as MyFolderGrantInfo[],
  grantsSettled: true,
  stats: new Map<string, SharedDriveStats>(),
  grantStats: [] as FolderGrantStatsState[],
  reload: vi.fn(async () => {}),
}));
vi.mock("@/components/page-sections/settings/multi-folder-sync/useDriveMemberships", () => ({
  useDriveMemberships: () => ({ data: withMe.data, reload: withMe.reload, markUnavailable: vi.fn() }),
}));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", () => ({
  useMyFolderGrants: () => ({ grants: withMe.grants, isSettled: withMe.grantsSettled }),
}));
vi.mock("@/app/lib/hooks/useSharedDriveStats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/hooks/useSharedDriveStats")>()),
  useSharedDriveStats: () => withMe.stats,
}));
vi.mock("@/app/lib/hooks/useFolderGrantStats", () => ({
  useFolderGrantStatsList: () => withMe.grantStats,
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
// the way to a new drive, which the real one reaches after closing itself.
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

// "Shared with me"'s rows: one line per drive, then folder, in the slice
// the page asks for, so the page's paging is visible.
const withMeProps = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("@/components/page-sections/settings/multi-folder-sync", () => ({
  SharedWithMeSection: (props: Record<string, unknown>) => {
    withMeProps.value = props;
    const ms = props.memberships as { data: SharedWithMeData };
    const names = [
      ...(ms.data.kind === "ready" ? ms.data.memberships.map((m) => m.displayLabel) : []),
      ...withMe.grants.map((g) => g.pathPrefix),
    ];
    const slice = props.slice as { start: number; end: number };
    const shown = names.slice(slice.start, slice.end);
    return shown.length ? (
      <div data-testid="with-me-rows">
        {shown.map((n) => (
          <div key={n}>{n}</div>
        ))}
      </div>
    ) : null;
  },
}));

import SharedDrivesView, { SHARED_DRIVES_TABS_LABEL } from "../SharedDrivesView";
import { SHARE_A_DRIVE_EMPTY_TITLE } from "../ShareADriveEmptyState";

const local = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  folderName: name,
  localPath: `/Users/me/${name}`,
  isLocal: true,
  status: "syncing",
  lastModified: 1,
  ...extra,
});

function membership(displayLabel: string, folderHash: string, extra: Partial<DriveMembershipInfo> = {}): DriveMembershipInfo {
  return {
    ownerSs58: OWNER,
    folderHash,
    displayLabel,
    role: "writer",
    createdAt: "2026-09-01T00:00:00Z",
    syncedLocally: false,
    localLabel: null,
    ...extra,
  };
}

const shared = (memberCount: number) => ({ memberCount, liveInviteCount: 0, totalInviteCount: 0 });

/** One own drive shared ("Team", 1 GB, 10 files) and two drives shared with you. */
function bothKinds() {
  folders.value = { local: [local("Team", { totalBytes: 1 * GB, fileCount: 10 }), local("Private")], remote: [] };
  sharing.byLabel = new Map([
    ["Team", shared(3)],
    ["Private", shared(0)],
  ]);
  withMe.data = {
    kind: "ready",
    memberships: [membership("Design", "aa".repeat(8)), membership("Research", "bb".repeat(8))],
  };
  withMe.stats = new Map([
    [`${OWNER}:${"aa".repeat(8)}`, { ownerSs58: OWNER, folderHash: "aa".repeat(8), totalBytes: 2 * GB, fileCount: 20, updatedAt: 0 }],
    [`${OWNER}:${"bb".repeat(8)}`, { ownerSs58: OWNER, folderHash: "bb".repeat(8), totalBytes: 4 * GB, fileCount: 40, updatedAt: 0 }],
  ]);
}

function renderPage(props: Parameters<typeof SharedDrivesView>[0] = {}) {
  const store = createStore();
  const utils = render(
    <Provider store={store}>
      <SharedDrivesView {...props} />
    </Provider>,
  );
  return { store, ...utils };
}

const totals = () => screen.getByTestId("shared-drives-totals");

beforeEach(() => {
  push.mockReset();
  requireUploadRoom.mockClear();
  folders.value = { local: [], remote: [] };
  sharing.byLabel = new Map();
  sharing.isPending = false;
  withMe.data = { kind: "ready", memberships: [] };
  withMe.grants = [];
  withMe.grantsSettled = true;
  withMe.stats = new Map();
  withMe.grantStats = [];
  withMeProps.value = null;
});

describe("your own shared drives", () => {
  it("lists only this account's drives that are shared, each marked Owner", async () => {
    folders.value = {
      local: [local("Team"), local("Private"), local("Theirs", { ownerSs58: OWNER })],
      remote: [],
    };
    sharing.byLabel = new Map([
      ["Team", shared(3)],
      ["Private", shared(0)],
    ]);
    renderPage();

    expect(await screen.findByText("Team")).toBeInTheDocument();
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
    expect(screen.queryByText("Theirs")).not.toBeInTheDocument();
    expect(screen.getByText("Owner")).toHaveAttribute("title", "You own this drive");
    expect(screen.getByText("Shared with 3")).toBeInTheDocument();
  });

  it("does not say nothing is shared while the sharing is still on its way", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.isPending = true;
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Loading shared drives")).toBeInTheDocument());
    expect(screen.queryByText(SHARE_A_DRIVE_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("does not say nothing is shared while the drives shared with you are on their way", async () => {
    folders.value = { local: [local("Private")], remote: [] };
    withMe.data = { kind: "loading" };
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Loading shared drives")).toBeInTheDocument());
    expect(screen.queryByText(SHARE_A_DRIVE_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("says so, with Share a drive and no totals, once nothing turns out to be shared either way", async () => {
    folders.value = { local: [local("Private")], remote: [] };
    renderPage();
    expect(await screen.findByText(SHARE_A_DRIVE_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByTestId("shared-drives-totals")).not.toBeInTheDocument();
  });

  it("opens a shared drive on this page, and its access from the row", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", shared(2)]]);
    const { store } = renderPage();

    fireEvent.click(await screen.findByText("Team"));
    expect(push).toHaveBeenCalledWith("/shared-drives?openLabel=Team");

    // The inline button and the menu item open the same panel.
    fireEvent.click(screen.getAllByRole("button", { name: "Manage access" })[0]!);
    expect(store.get(shareDriveModalAtom)).toEqual({ label: "Team", folderName: "Team" });

    fireEvent.click(screen.getByRole("button", { name: "Share drive…" }));
    expect(store.get(shareDialogAtom)).toEqual({ label: "Team", folderName: "Team" });
  });
});

describe("the tabs", () => {
  it("show only when both kinds exist, with a count each", async () => {
    bothKinds();
    renderPage();
    const tablist = await screen.findByRole("tablist", { name: SHARED_DRIVES_TABS_LABEL });
    const tabs = within(tablist).getAllByRole("tab");
    // The accessible name is the full label and the count, at every width.
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual([
      "All (3)",
      "Shared with you (2)",
      "Shared by you (1)",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("are not drawn with only drives you shared", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", shared(2)]]);
    renderPage();
    await screen.findByText("Team");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("are not drawn with only drives shared with you", async () => {
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    await screen.findByText("Design");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("narrow the list to one kind", async () => {
    bothKinds();
    renderPage();
    await screen.findByRole("tablist");
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Shared by you (1)" }));
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.queryByText("Design")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Shared with you (2)" }));
    expect(screen.queryByText("Team")).not.toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
  });

  it("move with the arrow keys, Home and End, as one tab stop", async () => {
    bothKinds();
    renderPage();
    const tablist = await screen.findByRole("tablist");
    const [all, withYou, byYou] = within(tablist).getAllByRole("tab");
    expect([all, withYou, byYou].map((t) => t!.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.keyDown(all!, { key: "ArrowRight" });
    expect(withYou).toHaveAttribute("aria-selected", "true");
    expect(withYou).toHaveFocus();
    expect(screen.queryByText("Team")).not.toBeInTheDocument();

    fireEvent.keyDown(withYou!, { key: "End" });
    expect(byYou).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(byYou!, { key: "ArrowRight" });
    expect(all).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(all!, { key: "ArrowLeft" });
    expect(byYou).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(byYou!, { key: "Home" });
    expect(all).toHaveAttribute("aria-selected", "true");
    expect(all!.tabIndex).toBe(0);
  });
});

describe("the totals", () => {
  it("add up every drive the list shows", async () => {
    bothKinds();
    renderPage();
    await screen.findByRole("tablist");
    // Drawn twice (own line in a narrow column, the tabs row from @2xl).
    expect(screen.getAllByText("7 GB").length).toBeGreaterThan(0);
    expect(within(totals()).getByText("Total size:")).toBeInTheDocument();
    expect(within(totals()).getByText("7 GB")).toBeInTheDocument();
    expect(within(totals()).getByText("70")).toBeInTheDocument();
  });

  it("follow the tab", async () => {
    bothKinds();
    renderPage();
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("tab", { name: "Shared by you (1)" }));
    expect(within(totals()).getByText("1 GB")).toBeInTheDocument();
    expect(within(totals()).getByText("10")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Shared with you (2)" }));
    expect(within(totals()).getByText("6 GB")).toBeInTheDocument();
    expect(within(totals()).getByText("60")).toBeInTheDocument();
  });

  it("leave out a drive whose size could not be read, rather than count it as zero", async () => {
    bothKinds();
    withMe.stats = new Map([...withMe.stats].slice(0, 1));
    renderPage();
    await screen.findByRole("tablist");
    expect(within(totals()).getByText("3 GB")).toBeInTheDocument();
    expect(within(totals()).getByText("30")).toBeInTheDocument();
  });

  it("show a dash, not a zero, when no drive in the list could be sized", async () => {
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    await screen.findByText("Design");
    expect(within(totals()).getAllByText("\u2014")).toHaveLength(2);
    expect(within(totals()).queryByText("0 B")).not.toBeInTheDocument();
  });

  it("count a shared folder by its own size", async () => {
    withMe.grants = [
      {
        ownerSs58: OWNER,
        folderHash: "cc".repeat(8),
        displayLabel: "Finance",
        pathPrefix: "/Reports",
        role: "reader",
        createdAt: "2026-09-01T00:00:00Z",
        canWrite: false,
      },
    ];
    withMe.grantStats = [{ kind: "ready", stats: { totalBytes: 0.5 * GB, fileCount: 5, truncated: false } }];
    renderPage();
    await screen.findByText("/Reports");
    expect(within(totals()).getByText("500 MB")).toBeInTheDocument();
    expect(within(totals()).getByText("5")).toBeInTheDocument();
  });
});

describe("paging", () => {
  it("pages one list: your drives first, then the ones shared with you", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Own ${String(i + 1).padStart(2, "0")}`);
    folders.value = { local: names.map((n) => local(n)), remote: [] };
    sharing.byLabel = new Map(names.map((n) => [n, shared(1)]));
    withMe.data = {
      kind: "ready",
      memberships: [membership("Design", "aa".repeat(8)), membership("Research", "bb".repeat(8))],
    };
    renderPage();

    await screen.findByText("Own 01");
    expect(screen.getByText("Own 08")).toBeInTheDocument();
    expect(screen.queryByText("Own 09")).not.toBeInTheDocument();
    expect(screen.queryByText("Design")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.queryByText("Own 08")).not.toBeInTheDocument();
    expect(screen.getByText("Own 09")).toBeInTheDocument();
    expect(screen.getByText("Own 10")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(withMeProps.value!.slice).toEqual({ start: 0, end: 2 });
  });

  it("starts each tab on its first page, and pages within it", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Own ${String(i + 1).padStart(2, "0")}`);
    folders.value = { local: names.map((n) => local(n)), remote: [] };
    sharing.byLabel = new Map(names.map((n) => [n, shared(1)]));
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    await screen.findByText("Own 01");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Own 09")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Shared by you (10)" }));
    expect(screen.getByText("Own 01")).toBeInTheDocument();
    expect(screen.queryByText("Own 09")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Own 10")).toBeInTheDocument();
    expect(screen.queryByText("Design")).not.toBeInTheDocument();

    // One page of drives shared with you needs no pager.
    fireEvent.click(screen.getByRole("tab", { name: "Shared with you (1)" }));
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
  });
});

describe("Share a drive", () => {
  it("sits in the page header and opens the picker of the account's own drives", async () => {
    folders.value = { local: [local("Mine"), local("Theirs", { ownerSs58: OWNER })], remote: [] };
    renderPage({ renderHeader: (actions) => <header data-testid="page-header">{actions}</header> });
    await screen.findByText(SHARE_A_DRIVE_EMPTY_TITLE);
    fireEvent.click(within(screen.getByTestId("page-header")).getByRole("button", { name: "Share a drive" }));
    expect(screen.getByRole("dialog", { name: "Share a drive picker" })).toBeInTheDocument();
    expect(screen.getByTestId("picker-drives")).toHaveTextContent(/^Mine$/);
  });

  it("is in the header even while the list has rows, and no longer in a card header", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", shared(2)]]);
    renderPage({ renderHeader: (actions) => <header data-testid="page-header">{actions}</header> });
    await screen.findByText("Team");
    expect(screen.getAllByRole("button", { name: "Share a drive" })).toHaveLength(1);
    expect(within(screen.getByTestId("page-header")).getByRole("button", { name: "Share a drive" })).toBeInTheDocument();
  });

  it("goes from a new drive to its Share dialog, one dialog at a time", async () => {
    const { store } = renderPage();
    await screen.findByText(SHARE_A_DRIVE_EMPTY_TITLE);

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
    await screen.findByText(SHARE_A_DRIVE_EMPTY_TITLE);
    fireEvent.click(screen.getAllByRole("button", { name: "Share a drive" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Picker new drive" }));
    await waitFor(() => expect(requireUploadRoom).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Add folder dialog" })).not.toBeInTheDocument();
  });
});

describe("drives shared with you", () => {
  it("are drawn as rows of the page's list, from the page's one fetch", async () => {
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    await screen.findByText("Design");
    expect(withMeProps.value).toMatchObject({ variant: "rows", alwaysShow: true });
    expect((withMeProps.value!.memberships as { data: SharedWithMeData }).data).toBe(withMe.data);
  });

  it("open on the Drive page by their browse label and name", async () => {
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    await screen.findByText("Design");
    const open = withMeProps.value!.onOpenDrive as (identity: object) => void;
    open({ ownerSs58: OWNER, folderHash: "ab".repeat(8), displayLabel: "Design" });
    const url = new URL(`app://x${push.mock.calls[0]![0]}`);
    expect(url.searchParams.get("openName")).toBe("Design");
    expect(url.searchParams.get("openRemote")).toBe("1");
    expect(url.searchParams.get("openLabel")).toContain(OWNER);
  });
});
