// The Manage access panel: one scrolling list grouped as People, Pending
// invites and Links, from one Rust fold (`list_access_panel`). Covers the
// header for an owner and for someone the drive is shared with, the groups
// and their counts, the empty and loading states, pessimistic changes on
// every row kind, locked links, the Share dialog hand-off, and Leave; and, for
// a big drive, rows that cut long words short beside a fixed role slot, the
// jump bar, five rows a group with "Show all", and the full view's search,
// chips, windowed list and actions (the Share dev tools' Big and Huge presets).

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, configure, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import ShareDrivePanel from "../ShareDrivePanel";
import {
  driveInvitesVersionAtom,
  shareDialogAtom,
  shareDriveModalAtom,
  type ShareDriveModalTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import type {
  AccessPanel,
  AccessPanelHolder,
  AccessPanelLink,
  AccessPanelMember,
  DriveMembershipInfo,
} from "@/app/lib/tauri/sharedDrives";

configure({ asyncUtilTimeout: 3000 });

// jsdom has no matchMedia; the panel runs in its inline shape.
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

// The overflow menus are Radix dropdowns that do not open under jsdom's
// pointer emulation; their items render as plain buttons so what each item
// DOES is exercised for real.
vi.mock("@/components/ui/alt-table/TableActionMenu", () => ({
  __esModule: true,
  default: ({ items }: { items: { itemTitle: React.ReactNode; onItemClick?: () => void }[] }) => (
    <div>
      {items.map((item, i) => (
        <button key={i} type="button" onClick={() => item.onItemClick?.()}>
          {item.itemTitle}
        </button>
      ))}
    </div>
  ),
}));

const flags = vi.hoisted(() => ({ sharedDrives: true }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flags.sharedDrives;
  },
  FOLDER_ROLES_ENABLED: true,
}));

vi.mock("@/app/lib/hooks/api/useStorageOverview", () => ({
  STORAGE_OVERVIEW_QUERY_KEY: "storage-overview",
  useStorageOverview: () => ({ data: { source: "subscription", plan: { name: "Plus" } } }),
}));

const unlockMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/hooks/useUnlockFlow", () => ({
  useUnlockFlow: () => ({ unlock: unlockMock, busy: false, isOAuth: true }),
}));

const memberships = vi.hoisted(() => ({ list: [] as DriveMembershipInfo[] }));
vi.mock("@/app/lib/hooks/useSharedDriveRoles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/hooks/useSharedDriveRoles")>();
  return { ...actual, useSharedDriveMemberships: () => memberships.list };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => <span data-testid="avatar" />;
    return Stub;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const listAccessPanelMock = vi.fn();
const changeRoleMock = vi.fn();
const removeMock = vi.fn();
const revokeMock = vi.fn();
const approveMock = vi.fn();
const replaceFoldersMock = vi.fn();
const leaveMock = vi.fn();
const leaveByIdentityMock = vi.fn();
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    listAccessPanel: (...a: unknown[]) => listAccessPanelMock(...a),
    changeDriveMemberRole: (...a: unknown[]) => changeRoleMock(...a),
    removeDriveMember: (...a: unknown[]) => removeMock(...a),
    revokeDriveInvite: (...a: unknown[]) => revokeMock(...a),
    approveEmailInvite: (...a: unknown[]) => approveMock(...a),
    replaceFolderGrants: (...a: unknown[]) => replaceFoldersMock(...a),
    leaveSharedDrive: (...a: unknown[]) => leaveMock(...a),
    leaveSharedDriveByIdentity: (...a: unknown[]) => leaveByIdentityMock(...a),
    listMyDriveMemberships: vi.fn().mockResolvedValue([]),
  };
});

const ME = "5MeAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER = "5OwnerBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ANN = "5AnnCccccccccccccccccccccccccccccccccccccccccccccc";
const BO = "5BoDddddddddddddddddddddddddddddddddddddddddddddd";

const DAY = 86_400;

function member(over: Partial<AccessPanelMember> = {}): AccessPanelMember {
  return { memberSs58: ANN, role: "writer", memberName: "Ann", isYou: false, createdAt: "2026-08-20T12:00:00Z", ...over };
}

function holder(over: Partial<AccessPanelHolder> = {}): AccessPanelHolder {
  return {
    memberSs58: BO,
    memberName: "Bo",
    isYou: false,
    role: "reader",
    pathPrefix: "Clients/ACME",
    folders: ["Clients/ACME", "Work"],
    ...over,
  };
}

function link(over: Partial<AccessPanelLink> = {}): AccessPanelLink {
  return {
    inviteId: "l1",
    role: "writer",
    mintedBy: ME,
    mintedByYou: true,
    useCount: 12,
    maxUses: 50,
    singleUse: false,
    usagePercent: 24,
    status: "active",
    expiresAt: "2026-09-29T12:00:00Z",
    neverExpires: false,
    expiresInSecs: 5 * DAY,
    inviteUrl: "https://console.hippius.com/invite/tok_abcdefgh#k=SECRETKEY",
    linkAvailable: true,
    ...over,
  };
}

function panel(over: Partial<AccessPanel> = {}): AccessPanel {
  return {
    ownerSs58: ME,
    ownerIsYou: true,
    yourRole: "owner",
    canManage: true,
    members: [],
    folderHolders: [],
    pendingInvites: [],
    links: [],
    inactiveLinks: [],
    linksLocked: false,
    driveMemberCount: 0,
    ...over,
  };
}

const full = () =>
  panel({
    members: [member()],
    folderHolders: [holder()],
    pendingInvites: [
      {
        inviteId: "p1",
        role: "reader",
        mintedBy: ME,
        expiresAt: "2026-10-01T00:00:00Z",
        maxUses: 1,
        useCount: 0,
        revoked: false,
        valid: true,
        createdAt: "t",
        recipientEmail: "mia@example.com",
        emailStatus: "awaiting_seal",
        expiresInSecs: 6 * DAY,
      },
    ],
    links: [link()],
    driveMemberCount: 1,
  });

function renderPanel(target: ShareDriveModalTarget | null = { label: "team-docs", folderName: "team-docs" }) {
  const store = createStore();
  store.set(shareDriveModalAtom, target);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>{(<ShareDrivePanel />) as ReactNode}</Provider>
    </QueryClientProvider>,
  );
  return store;
}

/** A loaded group's section; throws until it is on screen, for `waitFor`. */
function group(name: RegExp): HTMLElement {
  const section = screen.getByRole("heading", { name }).closest("section");
  if (!section) throw new Error("group not loaded yet");
  return section as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.sharedDrives = true;
  memberships.list = [];
  listAccessPanelMock.mockResolvedValue(full());
});

describe("gating", () => {
  it("renders nothing while the flag is off, even with a target", () => {
    flags.sharedDrives = false;
    renderPanel();
    expect(screen.queryByText("team-docs")).not.toBeInTheDocument();
  });

  it("renders nothing with no target", () => {
    renderPanel(null);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

describe("an owner's drive", () => {
  it("asks Rust once for the drive, with no folder and no wire identity", async () => {
    renderPanel();
    await screen.findByText("Ann");
    expect(listAccessPanelMock).toHaveBeenCalledWith("team-docs", null, undefined);
  });

  it("shows skeleton rows while loading, never a spinner", () => {
    listAccessPanelMock.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByRole("status", { name: "Loading access" })).toBeInTheDocument();
  });

  it("says whose drive it is and the plan it is on", async () => {
    renderPanel();
    expect(await screen.findByText("Your drive · Plus plan")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "team-docs" })).toBeInTheDocument();
  });

  it("groups people, pending invites and links, with counts", async () => {
    renderPanel();
    await screen.findByText("Ann");
    expect(screen.getByRole("heading", { name: "People 3" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pending invites 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Links 1 active" })).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("lists a folder holder with the people, tagged with their folder", async () => {
    renderPanel();
    const people = within(await waitFor(() => group(/^People/)));
    expect(people.getByText("Bo")).toBeInTheDocument();
    expect(people.getByText("Clients/ACME +1")).toBeInTheDocument();
    expect(people.getByText("Viewer")).toBeInTheDocument();
    expect(people.getByRole("button", { name: "Change folders" })).toBeInTheDocument();
    // A member's second line is their email, else when they joined.
    expect(people.getByText("Joined Aug 20, 2026")).toBeInTheDocument();
  });

  it("describes a link by its role, maker, usage and expiry, with the key hidden", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPanel();
    const links = within(await waitFor(() => group(/^Links/)));
    expect(links.getByText("Editor link")).toBeInTheDocument();
    expect(links.getByText(/by You/)).toBeInTheDocument();
    expect(links.getByText("12 of 50 used · Expires in 5 days")).toBeInTheDocument();
    expect(links.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "24");
    expect(links.queryByText(/SECRETKEY/)).not.toBeInTheDocument();
    fireEvent.click(links.getByRole("button", { name: "Copy invite link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link().inviteUrl));
  });

  it("says whether a single-use link was used, with no bar", async () => {
    listAccessPanelMock.mockResolvedValue(
      panel({ links: [link({ singleUse: true, maxUses: 1, useCount: 0, usagePercent: 0, role: "reader" })] }),
    );
    renderPanel();
    expect(await screen.findByText("Single use, not used yet · Expires in 5 days")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("folds ended links into one line until opened", async () => {
    listAccessPanelMock.mockResolvedValue(
      panel({
        links: [link()],
        inactiveLinks: [
          link({ inviteId: "x1", status: "revoked", inviteUrl: undefined, linkAvailable: false }),
          link({ inviteId: "x2", status: "expired", inviteUrl: undefined, linkAvailable: false }),
        ],
      }),
    );
    renderPanel();
    const line = await screen.findByRole("button", { name: /2 expired or revoked links/ });
    expect(screen.queryByText(/^Revoked/)).not.toBeInTheDocument();
    fireEvent.click(line);
    expect(screen.getByText(/^Revoked ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Expired ·/)).toBeInTheDocument();
  });

  it("shows the empty state when only the owner has access, and it opens the Share dialog", async () => {
    listAccessPanelMock.mockResolvedValue(panel());
    const store = renderPanel();
    expect(await screen.findByText("Only you have access")).toBeInTheDocument();
    expect(
      screen.getByText("Invite people by email or create a link to share this drive."),
    ).toBeInTheDocument();
    fireEvent.click(within(screen.getByText("Only you have access").parentElement!).getByRole("button", { name: "Share" }));
    const opened = store.get(shareDialogAtom);
    expect(opened).toEqual({ label: "team-docs", folderName: "team-docs", ownerSs58: undefined, folderHash: undefined });
    expect(opened && "pathPrefix" in opened).toBe(false);
    expect(store.get(shareDriveModalAtom)).toBeNull();
  });

  it("offers Invite, New link and Share, which all open the whole-drive Share dialog", async () => {
    for (const name of ["Invite", "New link", "Share"]) {
      const store = renderPanel();
      await screen.findAllByText("Ann");
      fireEvent.click(screen.getAllByRole("button", { name }).at(-1)!);
      expect(store.get(shareDialogAtom)).toMatchObject({ label: "team-docs" });
      expect(store.get(shareDriveModalAtom)).toBeNull();
      document.body.innerHTML = "";
    }
  });

  it("says changes apply right away in the footer", async () => {
    renderPanel();
    expect(await screen.findByText("Changes apply right away.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Leave/ })).not.toBeInTheDocument();
  });

  it("reads the list again when the Share dialog makes something", async () => {
    const store = renderPanel();
    await screen.findByText("Ann");
    act(() => store.set(driveInvitesVersionAtom, (n) => n + 1));
    await waitFor(() => expect(listAccessPanelMock).toHaveBeenCalledTimes(2));
  });

  it("says a server without shared drives is not ready", async () => {
    listAccessPanelMock.mockRejectedValue({ kind: "NotReady", subkind: "SHARED_DRIVES_UNAVAILABLE", message: "off" });
    renderPanel();
    expect(await screen.findByText("Shared drives aren't available on your server yet.")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("offers Try again after a failed load", async () => {
    listAccessPanelMock.mockRejectedValueOnce({ kind: "Hcfs", message: "boom" });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Ann")).toBeInTheDocument();
  });
});

describe("changes are pessimistic", () => {
  it("changes a role through the row's select, saying Saving until Rust answers", async () => {
    let finish: () => void = () => {};
    changeRoleMock.mockReturnValue(new Promise<void>((r) => (finish = r)));
    renderPanel();
    await screen.findByText("Ann");
    fireEvent.click(screen.getByLabelText("Role for Ann"));
    // Viewer and Editor only: nobody is made a Manager.
    expect(screen.queryByText("Manager")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Viewer").at(-1)!);
    // A demotion is confirmed first.
    fireEvent.click(await screen.findByRole("button", { name: "Change role" }));
    await waitFor(() => expect(changeRoleMock).toHaveBeenCalledWith("team-docs", ANN, "reader", undefined));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    listAccessPanelMock.mockResolvedValue(panel({ members: [member({ role: "reader" })] }));
    finish();
    await waitFor(() => expect(screen.getByLabelText("Role for Ann")).toHaveTextContent("Viewer"));
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  });

  it("leaves a refused change as it was and says why on the row", async () => {
    removeMock.mockRejectedValue({ kind: "Validation", message: "Not allowed." });
    renderPanel();
    await screen.findByText("Bo");
    fireEvent.click(screen.getByRole("button", { name: "Remove access" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Couldn't change access for Bo. Not allowed.")).toBeInTheDocument();
    expect(screen.getByText("Bo")).toBeInTheDocument();
  });

  it("revokes a link only after asking, saying Revoking meanwhile", async () => {
    let finish: () => void = () => {};
    revokeMock.mockReturnValue(new Promise<void>((r) => (finish = r)));
    renderPanel();
    const links = within(await waitFor(() => group(/^Links/)));
    fireEvent.click(links.getByRole("button", { name: "Revoke" }));
    expect(revokeMock).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith("team-docs", "l1", undefined));
    expect(await screen.findByText("Revoking…")).toBeInTheDocument();
    listAccessPanelMock.mockResolvedValue(panel({ members: [member()] }));
    finish();
    await waitFor(() => expect(screen.queryByText("Editor link")).not.toBeInTheDocument());
  });

  it("offers Approve only on an invitation that needs it, with its stage as a pill", async () => {
    approveMock.mockResolvedValue({ status: "sealed" });
    renderPanel();
    const pending = within(await waitFor(() => group(/^Pending invites/)));
    expect(pending.getByText("Needs approval")).toBeInTheDocument();
    expect(pending.getByText("Viewer · 6 days left")).toBeInTheDocument();
    fireEvent.click(pending.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approveMock).toHaveBeenCalledWith("team-docs", "p1", undefined));
  });

  it("cancels an invitation", async () => {
    revokeMock.mockResolvedValue(undefined);
    renderPanel();
    await screen.findByText("mia@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite to mia@example.com" }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith("team-docs", "p1", undefined));
  });

  it("changes a holder's folders and reads the list again", async () => {
    replaceFoldersMock.mockResolvedValue({ memberSs58: BO, pathPrefixes: ["Clients/ACME"], roles: ["reader"] });
    renderPanel();
    await screen.findByText("Bo");
    fireEvent.click(screen.getByRole("button", { name: "Change folders" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Work" }));
    fireEvent.click(screen.getByRole("button", { name: "Save folders" }));
    await waitFor(() =>
      expect(replaceFoldersMock).toHaveBeenCalledWith("team-docs", BO, ["Clients/ACME"], {
        role: undefined,
        target: undefined,
      }),
    );
    await waitFor(() => expect(listAccessPanelMock).toHaveBeenCalledTimes(2));
  });
});

describe("locked links", () => {
  it("says so and offers the unlock flow on the blurred field", async () => {
    listAccessPanelMock.mockResolvedValue(panel({ links: [link({ inviteUrl: undefined })], linksLocked: true }));
    renderPanel();
    expect(
      await screen.findByText("Links are locked. Enter your unlock password to show and copy them."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy invite link" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(unlockMock).toHaveBeenCalled();
  });
});

describe("a folder", () => {
  const target = { label: "team-docs", folderName: "team-docs", pathPrefix: "Clients/ACME" };

  it("asks about exactly the folder and names the drive it is in", async () => {
    renderPanel(target);
    expect(await screen.findByText("Folder in team-docs")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Clients/ACME" })).toBeInTheDocument();
    expect(listAccessPanelMock).toHaveBeenCalledWith("team-docs", "Clients/ACME", undefined);
  });

  it("says whole-drive members have the whole drive, and how to change a holder's access", async () => {
    renderPanel(target);
    expect(await screen.findByText("Has the whole drive")).toBeInTheDocument();
    expect(
      screen.getByText("To change someone’s access to this folder, remove them and invite them again."),
    ).toBeInTheDocument();
  });

  it("shares the folder, never the drive", async () => {
    const store = renderPanel(target);
    await screen.findByText("Ann");
    fireEvent.click(screen.getByRole("button", { name: "New link" }));
    expect(store.get(shareDialogAtom)).toMatchObject({ label: "team-docs", pathPrefix: "Clients/ACME" });
  });
});

describe("a drive shared with you", () => {
  const sharedWithMe = (role: string) =>
    panel({
      ownerSs58: OWNER,
      ownerIsYou: false,
      yourRole: role,
      canManage: false,
      members: [member({ memberSs58: ME, memberName: "Me", role, isYou: true }), member()],
    });

  beforeEach(() => {
    memberships.list = [
      {
        ownerSs58: OWNER,
        ownerName: "Olive",
        folderHash: "abc123",
        displayLabel: "team-docs",
        role: "writer",
        createdAt: "t",
        syncedLocally: true,
        localLabel: "team-docs",
        frozen: true,
        frozenUntil: null,
      },
    ];
  });

  it("names the owner and your role, and shows everyone read only", async () => {
    listAccessPanelMock.mockResolvedValue(sharedWithMe("writer"));
    renderPanel();
    expect(await screen.findByText("Shared with you by Olive · you are an Editor")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Ann")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Links/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
  });

  // A former Manager: Rust sends `writer` and `canManage: false`. Should a
  // `manager` ever arrive, it still reads as an Editor, never a Viewer.
  it("tells a former Manager they are an Editor, read only, with Leave", async () => {
    memberships.list = [{ ...memberships.list[0], role: "manager", frozen: false }];
    listAccessPanelMock.mockResolvedValue(sharedWithMe("manager"));
    renderPanel();
    expect(await screen.findByText("Shared with you by Olive · you are an Editor")).toBeInTheDocument();
    expect(screen.queryByText(/Manager/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Ann")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave drive" })).toBeInTheDocument();
  });

  it("says when the drive is frozen", async () => {
    listAccessPanelMock.mockResolvedValue(sharedWithMe("writer"));
    renderPanel();
    expect(await screen.findByText("This drive is frozen. Files can be opened but not changed.")).toBeInTheDocument();
  });

  it("gives anyone but the owner the read-only list and Leave, never Share", async () => {
    listAccessPanelMock.mockResolvedValue(sharedWithMe("reader"));
    renderPanel();
    expect(await screen.findByText("Shared with you by Olive · you are a Viewer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave drive" })).toBeInTheDocument();
    expect(screen.queryByText("Changes apply right away.")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Pending invites/ })).not.toBeInTheDocument();
  });

  it("leaves only after the confirmation, removing the synced drive too", async () => {
    listAccessPanelMock.mockResolvedValue(sharedWithMe("reader"));
    leaveMock.mockResolvedValue(undefined);
    const store = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Leave drive" }));
    expect(leaveMock).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Leave drive" }));
    await waitFor(() => expect(leaveMock).toHaveBeenCalledWith("team-docs"));
    await waitFor(() => expect(store.get(shareDriveModalAtom)).toBeNull());
  });
});

// The Share dev tools' presets, as the panel receives them.
async function presetPanel(id: "big" | "huge", over: Partial<AccessPanel> = {}): Promise<AccessPanel> {
  const { buildFixture, fixtureAccessPanel } = await import("../share-dialog/shareFixture");
  const { DEFAULT_SETTINGS, applyPreset } = await import("../share-dialog/shareDevToolsSettings");
  const now = Date.parse("2026-09-25T12:00:00Z");
  return { ...fixtureAccessPanel(buildFixture(applyPreset(DEFAULT_SETTINGS, id), null, now), false, now), ...over };
}

/** The rows of the full view's windowed list. */
function fullList(name: string): HTMLElement {
  return screen.getByRole("list", { name });
}

describe("rows never run under the role", () => {
  const LONG = "Srinivasa Ramanujan Aiyangar Venkataraghavan";

  it("cuts a long name and email short, with the role in a fixed slot of its own", async () => {
    listAccessPanelMock.mockResolvedValue(
      panel({ members: [member({ memberName: LONG, memberEmail: "srinivasa.ramanujan@research.example.com" })] }),
    );
    renderPanel();
    const name = await screen.findByText(LONG);
    expect(name).toHaveClass("truncate");
    // The words column takes what is left and clips, so nothing can paint
    // under the select beside it.
    expect(name.closest(".flex-1")).toHaveClass("min-w-0", "overflow-hidden");
    expect(screen.getByText("srinivasa.ramanujan@research.example.com")).toHaveClass("truncate");
    const slot = screen.getByLabelText(`Role for ${LONG}`).closest("span.shrink-0");
    expect(slot).toHaveClass("w-[98px]", "shrink-0");
    // The owner's role sits in a slot of the same width, so the column lines up.
    expect(screen.getByText("Owner").parentElement).toHaveClass("w-[98px]", "shrink-0");
  });

  it("offers the full name, email and address to keyboard and screen reader users", async () => {
    listAccessPanelMock.mockResolvedValue(panel({ members: [member({ memberName: LONG, memberEmail: "sr@example.com" })] }));
    renderPanel();
    const name = await screen.findByText(LONG);
    const trigger = name.parentElement!;
    expect(trigger).toHaveAttribute("tabindex", "0");
    expect(trigger).toHaveTextContent(`${LONG}, sr@example.com, address ${ANN}`);
  });

  it("cuts a long folder tag and a long pending address short too", async () => {
    const folder = "Clients/ACME Corporation International/2026 Quarterly Reports/Final versions";
    const address = "invitee.with.a.rather.long.address@research-and-development.example.com";
    listAccessPanelMock.mockResolvedValue(
      panel({
        folderHolders: [holder({ pathPrefix: folder, folders: [folder] })],
        pendingInvites: [{ ...full().pendingInvites[0], recipientEmail: address }],
      }),
    );
    renderPanel();
    const tag = await screen.findByText(folder);
    expect(tag).toHaveClass("truncate");
    expect(tag.parentElement).toHaveClass("max-w-[65%]");
    expect(screen.getByText(address)).toHaveClass("truncate");
    expect(screen.getByText(address)).toHaveAttribute("title", address);
  });
});

describe("a big drive", () => {
  it("counts every group in full, in the headers and the jump bar", async () => {
    listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
    renderPanel();
    expect(await screen.findByRole("heading", { name: "People 61" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pending invites 6" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Links 45 active" })).toBeInTheDocument();
    const bar = within(screen.getByRole("navigation", { name: "Jump to a group" }));
    expect(bar.getAllByRole("button").map((b) => b.textContent)).toEqual(["People61", "Pending6", "Links45"]);
    expect(screen.getByRole("button", { name: /15 expired or revoked links/ })).toBeInTheDocument();
  });

  it("draws five rows a group, then Show all with the group's full count", async () => {
    listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
    renderPanel();
    const people = within(await waitFor(() => group(/^People/)));
    // The owner and four more; every row with a role select is a member.
    expect(people.getAllByRole("listitem")).toHaveLength(5);
    expect(people.getByRole("button", { name: "Show all 61 people" })).toBeInTheDocument();
    const pending = within(group(/^Pending invites/));
    expect(pending.getAllByRole("listitem")).toHaveLength(5);
    expect(pending.getByRole("button", { name: "Show all 6 pending invites" })).toBeInTheDocument();
    const links = within(group(/^Links/));
    expect(links.getAllByRole("button", { name: "Revoke" })).toHaveLength(5);
    expect(links.getByRole("button", { name: "Show all 45 links" })).toBeInTheDocument();
  });

  it("jumps to a group from the bar: scrolls, focuses its heading and marks it for a moment", async () => {
    const scrollTo = vi.fn();
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo;
    try {
      listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
      renderPanel();
      await screen.findByRole("heading", { name: "Links 45 active" });
      const bar = within(screen.getByRole("navigation", { name: "Jump to a group" }));
      fireEvent.click(bar.getByRole("button", { name: "Links 45" }));
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      const heading = screen.getByRole("heading", { name: "Links 45 active" });
      expect(heading).toHaveFocus();
      expect(heading.parentElement).toHaveAttribute("data-highlighted", "true");
      await waitFor(() => expect(heading.parentElement).not.toHaveAttribute("data-highlighted"), { timeout: 2500 });
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
  });

  it("filters every group at once from the main search", async () => {
    listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
    renderPanel();
    const search = await screen.findByRole("searchbox", { name: "Search people, invites and links" });
    fireEvent.change(search, { target: { value: "invitee3@" } });
    expect(screen.getByText("invitee3@example.com")).toBeInTheDocument();
    expect(screen.queryByText("invitee1@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^People/ })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText("No one matches “zzzz”")).toBeInTheDocument();
  });

  it("opens a group's full view, lists it all behind search and chips, and goes back", async () => {
    listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Show all 61 people" }));
    expect(screen.getByRole("heading", { name: "People 61" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Jump to a group" })).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search people" });

    // Folder access: the six folder holders, and nobody else.
    fireEvent.click(screen.getByRole("button", { name: "Folder access" }));
    expect(screen.getByRole("button", { name: "Folder access" })).toHaveAttribute("aria-pressed", "true");
    expect(within(fullList("People")).getAllByRole("listitem")).toHaveLength(6);
    expect(within(fullList("People")).getAllByRole("button", { name: "Change folders" })).toHaveLength(6);

    // A search by email narrows it; one that matches nothing says so.
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(search, { target: { value: "sara.khan0@" } });
    expect(within(fullList("People")).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "nobody-here" } });
    expect(screen.getByText("No one matches “nobody-here”")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("navigation", { name: "Jump to a group" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all 61 people" })).toBeInTheDocument();
  });

  it("changes a role from the full view, saying Saving until Rust answers", async () => {
    let finish: () => void = () => {};
    changeRoleMock.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const big = await presetPanel("big");
    listAccessPanelMock.mockResolvedValue(big);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Show all 61 people" }));
    const search = screen.getByRole("searchbox", { name: "Search people" });
    // Someone past the first five rows of the main view.
    const target = big.members[40];
    fireEvent.change(search, { target: { value: target.memberSs58 } });
    const select = within(fullList("People")).getByRole("combobox");
    fireEvent.click(select);
    const next = target.role === "writer" ? "Viewer" : "Editor";
    fireEvent.click(screen.getAllByText(next).at(-1)!);
    if (next === "Viewer") fireEvent.click(await screen.findByRole("button", { name: "Change role" }));
    await waitFor(() => expect(changeRoleMock).toHaveBeenCalledWith("team-docs", target.memberSs58, next === "Viewer" ? "reader" : "writer", undefined));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    finish();
    await waitFor(() => expect(screen.queryByText("Saving…")).not.toBeInTheDocument());
    // Still in the full view, on the same search.
    expect(screen.getByRole("searchbox", { name: "Search people" })).toHaveValue(target.memberSs58);
  });

  it("revokes a link from the Links full view, and lists ended links under Ended", async () => {
    revokeMock.mockReturnValue(new Promise<void>(() => {}));
    listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Show all 45 links" }));
    const list = within(fullList("Links"));
    fireEvent.click(list.getAllByRole("button", { name: "Revoke" })[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledWith("team-docs", "fixture-link-0", undefined));
    expect(await screen.findByText("Revoking…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ended" }));
    expect(within(fullList("Links")).getAllByText(/^(Revoked|Expired|All uses taken) ·/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search links" }), { target: { value: "nobody" } });
    expect(screen.getByText("No one matches “nobody”")).toBeInTheDocument();
  });

  it("searches pending invitations by email in their full view", async () => {
    listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Show all 6 pending invites" }));
    expect(within(fullList("Pending invites")).getAllByRole("listitem")).toHaveLength(6);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search pending invites" }), { target: { value: "invitee4" } });
    expect(within(fullList("Pending invites")).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Viewer" })).not.toBeInTheDocument();
  });

  it("opens straight on the people when the Share dialog's more row asked for it", async () => {
    listAccessPanelMock.mockResolvedValue(await presetPanel("big"));
    renderPanel({ label: "team-docs", folderName: "team-docs", openOn: "people" });
    expect(await screen.findByRole("list", { name: "People" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });
});

describe("the Huge preset", () => {
  it("renders every group without errors and draws only a window of a 100-row list", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      listAccessPanelMock.mockResolvedValue(await presetPanel("huge"));
      renderPanel();
      expect(await screen.findByRole("heading", { name: "People 101" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show all 50 pending invites" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Show all 100 links" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show all 101 people" }));
      const rows = within(fullList("People")).getAllByRole("listitem");
      expect(rows.length).toBeGreaterThan(5);
      expect(rows.length).toBeLessThan(101);
      expect(rows[0]).toHaveAttribute("aria-setsize", "101");
      // A person far down the list is one search away.
      fireEvent.change(screen.getByRole("searchbox", { name: "Search people" }), { target: { value: "Srinivasa" } });
      expect(within(fullList("People")).getAllByText("Srinivasa Ramanujan Aiyangar Venkataraghavan").length).toBeGreaterThan(0);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the jump bar for someone the drive is shared with", () => {
  it("shows only People, with no pending invites or links to jump to", async () => {
    memberships.list = [
      {
        ownerSs58: OWNER,
        ownerName: "Olive",
        folderHash: "abc123",
        displayLabel: "team-docs",
        role: "reader",
        createdAt: "t",
        syncedLocally: true,
        localLabel: "team-docs",
        frozen: false,
        frozenUntil: null,
      },
    ];
    const big = await presetPanel("big", { ownerSs58: OWNER, ownerIsYou: false, yourRole: "reader", canManage: false });
    listAccessPanelMock.mockResolvedValue(big);
    renderPanel();
    const bar = within(await screen.findByRole("navigation", { name: "Jump to a group" }));
    expect(bar.getAllByRole("button").map((b) => b.textContent)).toEqual(["People61"]);
    expect(screen.queryByRole("heading", { name: /^Pending invites/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all 61 people" }));
    expect(within(fullList("People")).queryByRole("combobox")).not.toBeInTheDocument();
  });
});
