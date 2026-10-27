// The Shared Drives page: one list of your own shared drives and the ones
// shared with you, narrowed by underline tabs once anything is listed, with
// the total size and file count of what the list shows; it never claims
// "nothing shared" before both kinds are known, nor about a list that
// failed to load (an error with Try again instead); each empty tab says what
// goes there; it pages the list as one, ten to a page; "Share a drive" in
// the page header opens the picker, which makes and shares a new drive
// itself with no folder dialog, and on a plan without sharing names the plan
// and goes to the upgrade instead, while drives shared with the account
// still list. The picker and "Shared with me"'s rows are stubbed: each has
// its own tests, and here only the page's wiring of them is the question.

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

const folders = vi.hoisted(() => ({
  value: { local: [] as unknown[], remote: [] as unknown[] },
}));
const foldersFail = vi.hoisted(() => ({ value: false }));
const fetchFolders = vi.hoisted(() =>
  vi.fn(async () => {
    if (foldersFail.value) throw new Error("offline");
    return folders.value;
  }),
);
vi.mock("@/app/lib/tauri/syncFolders", () => ({
  fetchSyncFoldersWithStats: fetchFolders,
}));

const sharing = vi.hoisted(() => ({
  byLabel: new Map<string, DriveSharing>(),
  isPending: false,
  isError: false,
  refetch: vi.fn(),
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
const refetchGrants = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/hooks/useSharedDriveRoles", () => ({
  useMyFolderGrants: () => ({ grants: withMe.grants, isSettled: withMe.grantsSettled, refetch: refetchGrants }),
}));

// This account's plan: true shares, false is Free or Starter, undefined is
// still loading.
const plan = vi.hoisted(() => ({ allows: true as boolean | undefined }));
vi.mock("@/app/lib/hooks/useSharedDrivesInPlan", () => ({
  useSharedDrivesInPlan: () => plan.allows,
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

// The picker's own Continue, New drive and close rules are tested with it.
// Here it only reports what the page handed it, and closes.
const pickerProps = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("@/components/page-sections/drive/share-drive-picker/ShareDriveFlow", () => ({
  __esModule: true,
  default: (props: { drives: string[]; onClose: () => void }) => {
    pickerProps.value = props as unknown as Record<string, unknown>;
    return (
      <div role="dialog" aria-label="Share a drive picker">
        <span data-testid="picker-drives">{props.drives.join(",")}</span>
        <button type="button" onClick={props.onClose}>
          Picker close
        </button>
      </div>
    );
  },
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
import { sharedDrivesEmptyCopy, sharedDrivesErrorCopy } from "../sharedDrivesCopy";

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
  pickerProps.value = null;
  folders.value = { local: [], remote: [] };
  sharing.byLabel = new Map();
  sharing.isPending = false;
  sharing.isError = false;
  sharing.refetch.mockClear();
  refetchGrants.mockClear();
  withMe.reload.mockClear();
  fetchFolders.mockClear();
  foldersFail.value = false;
  plan.allows = true;
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
    sharing.byLabel = new Map([["Private", shared(0)]]);
    withMe.data = { kind: "loading" };
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Loading shared drives")).toBeInTheDocument());
    expect(screen.queryByText(SHARE_A_DRIVE_EMPTY_TITLE)).not.toBeInTheDocument();
  });

  it("says so, with Share a drive and no totals, once nothing turns out to be shared either way", async () => {
    folders.value = { local: [local("Private")], remote: [] };
    sharing.byLabel = new Map([["Private", shared(0)]]);
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

  it("are drawn with only drives you shared, and the empty tab says what goes there", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", shared(2)]]);
    renderPage();
    await screen.findByText("Team");
    expect(screen.getByRole("tab", { name: "Shared with you (0)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Shared with you (0)" }));
    expect(screen.queryByText("Team")).not.toBeInTheDocument();
    const copy = sharedDrivesEmptyCopy("with-you", true);
    expect(screen.getByRole("region", { name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.description)).toBeInTheDocument();
    // Nothing for this account to do there: no button in the card.
    expect(within(screen.getByTestId("shared-drives-empty-with-you")).queryByRole("button")).not.toBeInTheDocument();
    // No totals over an empty tab, in either place they are drawn.
    expect(screen.queryByTestId("shared-drives-totals")).not.toBeInTheDocument();
    expect(screen.queryByText("Total size:")).not.toBeInTheDocument();

    // Back on a tab with rows, they return.
    fireEvent.click(screen.getByRole("tab", { name: "Shared by you (1)" }));
    expect(within(totals()).getByText("Total size:")).toBeInTheDocument();
  });

  it("are drawn with only drives shared with you, and an empty Shared by you offers Share a drive", async () => {
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    await screen.findByText("Design");
    fireEvent.click(screen.getByRole("tab", { name: "Shared by you (0)" }));
    const card = screen.getByTestId("shared-drives-empty-by-you");
    expect(within(card).getByText(sharedDrivesEmptyCopy("by-you", true).title)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Share a drive/ }));
    expect(screen.getByRole("dialog", { name: "Share a drive picker" })).toBeInTheDocument();
  });

  it("stay on an emptied tab after leaving its last drive, saying so", async () => {
    bothKinds();
    const { rerender } = renderPage();
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("tab", { name: "Shared with you (2)" }));
    withMe.data = { kind: "ready", memberships: [] };
    withMe.stats = new Map();
    rerender(
      <Provider store={createStore()}>
        <SharedDrivesView />
      </Provider>,
    );
    expect(await screen.findByTestId("shared-drives-empty-with-you")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Shared with you (0)" })).toHaveAttribute("aria-selected", "true");
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
  const ownNames = (n: number) => Array.from({ length: n }, (_, i) => `Own ${String(i + 1).padStart(2, "0")}`);
  function ownShared(n: number) {
    const names = ownNames(n);
    folders.value = { local: names.map((name) => local(name)), remote: [] };
    sharing.byLabel = new Map(names.map((name) => [name, shared(1)]));
  }

  it("draws no pager for ten drives", async () => {
    ownShared(10);
    renderPage();
    await screen.findByText("Own 10");
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
  });

  it("pages one list, ten to a page: your drives first, then the ones shared with you", async () => {
    ownShared(10);
    withMe.data = {
      kind: "ready",
      memberships: [membership("Design", "aa".repeat(8)), membership("Research", "bb".repeat(8))],
    };
    renderPage();

    await screen.findByText("Own 01");
    expect(screen.getByText("Own 10")).toBeInTheDocument();
    expect(screen.queryByText("Design")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.queryByText("Own 10")).not.toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(withMeProps.value!.slice).toEqual({ start: 0, end: 2 });
  });

  it("starts each tab on its first page, pages within it, and hides the pager for a tab of ten or fewer", async () => {
    ownShared(12);
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    await screen.findByText("Own 01");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Own 11")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Shared by you (12)" }));
    expect(screen.getByText("Own 01")).toBeInTheDocument();
    expect(screen.queryByText("Own 11")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Own 12")).toBeInTheDocument();
    expect(screen.queryByText("Design")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Shared with you (1)" }));
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();
  });

  it("moves back a page, and drops the pager, when drives on the last page go away", async () => {
    ownShared(10);
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    const { rerender } = renderPage();
    await screen.findByText("Own 01");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Design")).toBeInTheDocument();

    // Leaving "Design" empties page 2.
    withMe.data = { kind: "ready", memberships: [] };
    rerender(
      <Provider store={createStore()}>
        <SharedDrivesView />
      </Provider>,
    );
    expect(await screen.findByText("Own 01")).toBeInTheDocument();
    expect(screen.getByText("Own 10")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2" })).not.toBeInTheDocument();

    // A drive coming back starts from page 1, not the stale page 2.
    withMe.data = { kind: "ready", memberships: [membership("Research", "bb".repeat(8))] };
    rerender(
      <Provider store={createStore()}>
        <SharedDrivesView />
      </Provider>,
    );
    expect(await screen.findByText("Own 01")).toBeInTheDocument();
    expect(screen.queryByText("Research")).not.toBeInTheDocument();
  });
});

describe("a plan without sharing", () => {
  it("names the plan on Share a drive and goes to the upgrade, never to the picker", async () => {
    plan.allows = false;
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage({ renderHeader: (actions) => <header data-testid="page-header">{actions}</header> });
    await screen.findByText("Design");
    const button = within(screen.getByTestId("page-header")).getByTestId("share-a-drive-upgrade");
    expect(button).toHaveTextContent("Share a drive");
    expect(button).toHaveTextContent("Plus");
    fireEvent.click(button);
    expect(push).toHaveBeenCalledWith("/settings?section=billing");
    expect(screen.queryByRole("dialog", { name: "Share a drive picker" })).not.toBeInTheDocument();
  });

  it("still lists and opens the drives shared with the account", async () => {
    plan.allows = false;
    withMe.data = { kind: "ready", memberships: [membership("Design", "aa".repeat(8))] };
    renderPage();
    expect(await screen.findByText("Design")).toBeInTheDocument();
    const open = withMeProps.value!.onOpenDrive as (identity: object) => void;
    open({ ownerSs58: OWNER, folderHash: "aa".repeat(8), displayLabel: "Design" });
    expect(push).toHaveBeenCalledWith(expect.stringContaining("openName=Design"));
  });

  it("offers the upgrade with nothing shared either way, and says joining works on any plan", async () => {
    plan.allows = false;
    renderPage();
    const copy = sharedDrivesEmptyCopy("all", false);
    expect(await screen.findByText(copy.description)).toBeInTheDocument();
    const card = screen.getByTestId("shared-drives-empty-all");
    expect(within(card).queryByRole("button", { name: /Share a drive/ })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Upgrade plan/ }));
    expect(push).toHaveBeenCalledWith("/settings?section=billing");
  });

  it("keeps a downgraded owner's shared drives listed, with Manage access", async () => {
    plan.allows = false;
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", shared(2)]]);
    renderPage();
    expect(await screen.findByText("Team")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Manage access" }).length).toBeGreaterThan(0);
  });

  it("shows neither version of the button, nor an empty state, while the plan loads", async () => {
    plan.allows = undefined;
    renderPage({ renderHeader: (actions) => <header data-testid="page-header">{actions}</header> });
    await waitFor(() => expect(screen.getByLabelText("Loading shared drives")).toBeInTheDocument());
    expect(screen.getByTestId("share-a-drive-placeholder")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Share a drive/ })).not.toBeInTheDocument();
    expect(screen.queryByText(SHARE_A_DRIVE_EMPTY_TITLE)).not.toBeInTheDocument();
  });
});

describe("a list that could not load", () => {
  it("says so with Try again, never that nothing is shared, when the drives shared with you failed", async () => {
    withMe.data = { kind: "error" };
    renderPage();
    const alert = await screen.findByTestId("shared-drives-error");
    expect(alert).toHaveTextContent(sharedDrivesErrorCopy("all", false).title);
    expect(screen.queryByText(SHARE_A_DRIVE_EMPTY_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByTestId("shared-drives-totals")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: /Try again/ }));
    });
    expect(withMe.reload).toHaveBeenCalled();
    expect(sharing.refetch).toHaveBeenCalled();
    expect(refetchGrants).toHaveBeenCalled();
    // The drive listing answered, so it is not asked again: reloading it
    // would blank rows already on screen.
    expect(fetchFolders).toHaveBeenCalledTimes(1);
  });

  it("says so when the drive listing failed, and lists the drives once Try again gets an answer", async () => {
    foldersFail.value = true;
    renderPage();
    const alert = await screen.findByTestId("shared-drives-error");

    foldersFail.value = false;
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", shared(2)]]);
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: /Try again/ }));
    });
    expect(await screen.findByText("Team")).toBeInTheDocument();
    expect(screen.queryByTestId("shared-drives-error")).not.toBeInTheDocument();
  });

  it("says so when no own drive's sharing could be read", async () => {
    folders.value = { local: [local("Team"), local("Archive")], remote: [] };
    renderPage();
    expect(await screen.findByTestId("shared-drives-error")).toBeInTheDocument();
  });

  it("says so when the sharing query failed", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.isError = true;
    renderPage();
    expect(await screen.findByTestId("shared-drives-error")).toBeInTheDocument();
  });

  it("shows the rows that did load, names the half that is missing, and leaves its count off", async () => {
    folders.value = { local: [local("Team")], remote: [] };
    sharing.byLabel = new Map([["Team", shared(2)]]);
    withMe.data = { kind: "error" };
    renderPage();
    expect(await screen.findByText("Team")).toBeInTheDocument();
    const line = screen.getByTestId("shared-drives-partial-error");
    expect(line).toHaveTextContent(/shared with you couldn't load/);
    // No "(0)": that would claim nothing is shared with you.
    expect(screen.getByRole("tab", { name: "Shared with you" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Shared with you" }));
    expect(screen.getByTestId("shared-drives-error")).toHaveTextContent(sharedDrivesErrorCopy("with-you", false).title);
    // A tab that could not load has no totals: "0 B" there would be wrong.
    expect(screen.queryByText("Total size:")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(screen.getByTestId("shared-drives-error")).getByRole("button", { name: /Try again/ }));
    });
    expect(withMe.reload).toHaveBeenCalled();
  });

  it("says it is offline, and loads again by itself once back online", async () => {
    const onLine = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    withMe.data = { kind: "error" };
    renderPage();
    expect(await screen.findByText(sharedDrivesErrorCopy("all", true).description)).toBeInTheDocument();
    expect(withMe.reload).not.toHaveBeenCalled();

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(withMe.reload).toHaveBeenCalled());
    onLine.mockRestore();
  });
});

describe("Share a drive", () => {
  it("sits in the page header and opens the picker of the account's own drives", async () => {
    folders.value = { local: [local("Mine"), local("Theirs", { ownerSs58: OWNER })], remote: [] };
    sharing.byLabel = new Map([["Mine", shared(0)]]);
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

  it("hands the picker no way to sync a folder: a new drive is made inside it", async () => {
    const { store } = renderPage();
    await screen.findByText(SHARE_A_DRIVE_EMPTY_TITLE);

    fireEvent.click(screen.getAllByRole("button", { name: "Share a drive" })[0]!);
    expect(pickerProps.value).not.toBeNull();
    expect(Object.keys(pickerProps.value!).sort()).toEqual(["drives", "loading", "onClose", "sharingByLabel"]);
    fireEvent.click(screen.getByRole("button", { name: "Picker close" }));
    expect(screen.queryByRole("dialog", { name: "Share a drive picker" })).not.toBeInTheDocument();
    // No folder dialog anywhere on the page, and nothing opened behind it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(store.get(shareDialogAtom)).toBeNull();
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
