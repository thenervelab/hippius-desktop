// State coverage for `ShareDriveModal` (owner invite mint + members
// management): flag OFF renders nothing; the invite machine's
// choosing → running → done (auto-copy) and → error / unavailable
// terminals; the members tab's loading / rows / empty / unavailable
// views and the two-step remove.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import ShareDriveModal from "../ShareDrivePanel";
import {
  serverCapabilitiesAtom,
  shareDriveModalAtom,
  type ShareDriveModalTarget,
} from "@/app/lib/global-atoms/sharesAtoms";

// Flip the flag per test — the modal reads it at render time.
// The panel slides inline on large screens and overlays below; jsdom has no
// matchMedia, and these tests are about the tabs rather than the shell, so
// they run in the inline shape.
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

const flagState = vi.hoisted(() => ({ sharedDrivesEnabled: true }));
// The overflow menu is Radix-backed and does not open under jsdom's pointer
// emulation. These tests are about what the row DOES with its two actions,
// not about Radix, so the shell renders its items as plain buttons and the
// behaviour underneath is exercised for real.
vi.mock("@/components/ui/alt-table/TableActionMenu", () => ({
  __esModule: true,
  default: ({
    items,
    children,
  }: {
    items: { itemTitle: React.ReactNode; onItemClick?: () => void }[];
    children: React.ReactNode;
  }) => (
    <div>
      {children}
      {items.map((item, i) => (
        <button key={i} type="button" onClick={() => item.onItemClick?.()}>
          {item.itemTitle}
        </button>
      ))}
    </div>
  ),
}));

// The panel reads the signed-in address so a link the reader minted
// themselves does not say so on every row.
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Me" }),
}));

const folderRolesFlag = vi.hoisted(() => ({ on: false }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flagState.sharedDrivesEnabled;
  },
  get FOLDER_ROLES_ENABLED() {
    return folderRolesFlag.on;
  },
}));

// The modal's only side effects are the sharedDrives wrappers; mocking the
// wrapper module (not raw invoke) keeps the tests on the modal's contract.
const createDriveInviteMock = vi.fn();
const listDriveMembersMock = vi.fn();
const listDriveFolderGrantsMock = vi.fn();
const removeDriveMemberMock = vi.fn();
const changeDriveMemberRoleMock = vi.fn();
const listDriveInvitesMock = vi.fn();
const revokeDriveInviteMock = vi.fn();
const approveEmailInviteMock = vi.fn();
const changeFolderGrantRoleMock = vi.fn();
const replaceFolderGrantsMock = vi.fn();

/** A stable member address, so the role assertions read for themselves. */
const MEMBER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    createDriveInvite: (...args: unknown[]) => createDriveInviteMock(...args),
    listDriveMembers: (...args: unknown[]) => listDriveMembersMock(...args),
    listDriveFolderGrants: (...args: unknown[]) =>
      listDriveFolderGrantsMock(...args),
    removeDriveMember: (...args: unknown[]) => removeDriveMemberMock(...args),
    changeDriveMemberRole: (...args: unknown[]) =>
      changeDriveMemberRoleMock(...args),
    listDriveInvites: (...args: unknown[]) => listDriveInvitesMock(...args),
    revokeDriveInvite: (...args: unknown[]) => revokeDriveInviteMock(...args),
    approveEmailInvite: (...args: unknown[]) => approveEmailInviteMock(...args),
    changeFolderGrantRole: (...args: unknown[]) => changeFolderGrantRoleMock(...args),
    replaceFolderGrants: (...args: unknown[]) => replaceFolderGrantsMock(...args),
  };
});

const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

// `next/dynamic` wraps boring-avatars; a plain stub avoids lazy-loading
// timing in jsdom.
vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = ({ name }: { name?: string }) => <span data-testid="avatar" data-name={name} />;
    Stub.displayName = "AvatarStub";
    return Stub;
  },
}));

// The upgrade CTA navigates to the in-app plans page.
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const UNAVAILABLE = { kind: "NotReady", subkind: "SHARED_DRIVES_UNAVAILABLE", message: "off" };


function renderModal(target: { label: string; folderName: string } | null = { label: "team-docs", folderName: "team-docs" }) {
  const store = createStore();
  store.set(shareDriveModalAtom, target);
  // The surface invalidates the drive list's sharing query on a mutation,
  // so it reads the query client.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>{(<ShareDriveModal />) as ReactNode}</Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  flagState.sharedDrivesEnabled = true;
  listDriveFolderGrantsMock.mockResolvedValue([]);
});




/** Open a member row's overflow menu and pick one of its two items. */
function openMemberMenu(_memberSs58: string, item: "Change role" | "Remove from drive") {
  fireEvent.click(screen.getByRole("button", { name: item }));
}

/**
 * Drive the Change role dialog through to Save. The role commits on Save,
 * never on selection — picking is not deciding.
 */
function changeMemberRoleTo(memberSs58: string, optionLabel: string) {
  openMemberMenu(memberSs58, "Change role");
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(optionLabel) }));
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
}

describe("flag gating", () => {
  it("renders nothing while SHARED_DRIVES_ENABLED is off, even with a target set", () => {
    flagState.sharedDrivesEnabled = false;
    renderModal();
    expect(screen.queryByText(/Share "team-docs"/)).not.toBeInTheDocument();
  });

  it("renders nothing with no target", () => {
    renderModal(null);
    expect(screen.queryByText(/Share "team-docs"/)).not.toBeInTheDocument();
  });
});

describe("members tab", () => {
  it("loads members on open, since that is the tab the panel starts on", async () => {
    listDriveMembersMock.mockResolvedValue([
      {
        memberSs58: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
        role: "writer",
        createdAt: "2026-08-20T00:00:00Z",
      },
    ]);

    renderModal();

    // Members is the default tab: the panel only opens on a drive that is
    // already shared, so "who is in it" is the question being asked.
    // The row reads the role people recognise, not the wire spelling. "Editor"
    // appears twice by design -- the row's label and the picker's option -- so
    // this asserts the wire word is absent rather than counting matches.
    await waitFor(() =>
      expect(screen.getAllByText(/Editor/).length).toBeGreaterThan(0),
    );
    expect(screen.queryByText(/writer/)).not.toBeInTheDocument();
    // An own drive resolves by label and names no wire identity; passing one
    // would address somebody else's namespace.
    expect(listDriveMembersMock).toHaveBeenCalledWith("team-docs", undefined);
  });

  it("offers every role in the dialog, starting on the one the member has", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "writer", createdAt: "2026-08-20T00:00:00Z" },
    ]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByRole("button", { name: "Change role" });
    openMemberMenu(MEMBER, "Change role");

    // Radios (console parity): every role and its description is visible at
    // once; the member's current role starts checked.
    expect(await screen.findByRole("radio", { name: /Editor/ })).toBeChecked();
    for (const label of ["Viewer", "Editor", "Manager"]) {
      expect(screen.getByRole("radio", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  // Picking a role used to commit it. A mis-click then changed what somebody
  // could do to the drive, with a toast as the only notice.
  it("does not change the role until Save is pressed", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "writer", createdAt: "2026-08-20T00:00:00Z" },
    ]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByRole("button", { name: "Change role" });
    openMemberMenu(MEMBER, "Change role");

    fireEvent.click(await screen.findByRole("radio", { name: /Manager/ }));
    expect(changeDriveMemberRoleMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(changeDriveMemberRoleMock).toHaveBeenCalled());
  });

  // Saving the role somebody already has is a round-trip that changes nothing.
  it("offers no Save until a different role is picked", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "writer", createdAt: "2026-08-20T00:00:00Z" },
    ]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByRole("button", { name: "Change role" });
    openMemberMenu(MEMBER, "Change role");

    expect(await screen.findByRole("button", { name: "Save role" })).toBeDisabled();
  });

  it("changes a role and refetches, so the row reflects the server", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "writer", createdAt: "2026-08-20T00:00:00Z" },
    ]);
    changeDriveMemberRoleMock.mockResolvedValue(undefined);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByRole("button", { name: "Change role" });
    changeMemberRoleTo(MEMBER, "Manager");

    await waitFor(() =>
      expect(changeDriveMemberRoleMock).toHaveBeenCalledWith(
        "team-docs",
        MEMBER,
        "manager",
        undefined,
      ),
    );
    // Refetched rather than patched in place: the server is the authority on
    // what the role became, and a demotion has side effects (revoked invites)
    // this row cannot infer.
    await waitFor(() => expect(listDriveMembersMock).toHaveBeenCalledTimes(2));
  });

  // The backend's refusals are written for the user -- "you cannot change your
  // own role", the named role, the manager caps -- so they must reach them.
  it("surfaces the backend's refusal verbatim", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "manager", createdAt: "2026-08-20T00:00:00Z" },
    ]);
    changeDriveMemberRoleMock.mockRejectedValue({
      kind: "Validation",
      message: "You cannot change your own role. Leave the drive instead.",
    });

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByRole("button", { name: "Change role" });
    changeMemberRoleTo(MEMBER, "Viewer");

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("You cannot change your own role"),
      ),
    );
  });

  it("shows the empty state when nobody joined yet", async () => {
    listDriveMembersMock.mockResolvedValue([]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText(/No one has joined this drive yet/);
  });

  it("degrades quietly when the server is feature-off", async () => {
    listDriveMembersMock.mockRejectedValue(UNAVAILABLE);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText(/aren't available on your server yet/);
  });

  it("removes a member only after the confirm dialog, then refetches", async () => {
    const member = {
      memberSs58: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
      role: "writer",
      createdAt: "2026-08-20T00:00:00Z",
    };
    listDriveMembersMock.mockResolvedValueOnce([member]).mockResolvedValueOnce([]);
    removeDriveMemberMock.mockResolvedValue(undefined);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByRole("button", { name: "Remove from drive" });

    // Picking the menu item only opens the confirm; nothing is removed yet.
    openMemberMenu(member.memberSs58, "Remove from drive");
    expect(removeDriveMemberMock).not.toHaveBeenCalled();
    // The confirmation names the DRIVE, never the member's raw address.
    const confirmText = await screen.findByText(/Remove this member from/);
    expect(confirmText.textContent).not.toContain(member.memberSs58);

    fireEvent.click(await screen.findByRole("button", { name: /Remove/ }));
    await waitFor(() =>
      expect(removeDriveMemberMock).toHaveBeenCalledWith("team-docs", member.memberSs58, undefined),
    );
    await screen.findByText(/No one has joined this drive yet/);
  });
});

describe("links tab", () => {
  const liveInvite = {
    inviteId: "abc123",
    role: "writer",
    expiresAt: "2126-09-12T12:00:00Z",
    maxUses: 50,
    useCount: 2,
    revoked: false,
    valid: true,
    createdAt: "2026-09-17T12:00:00Z",
    linkAvailable: true,
    inviteUrl: "https://console.example.com/invite/tok_abcdefgh#k=SECRETKEY",
  };

  it("lists links only when the tab is opened", async () => {
    listDriveInvitesMock.mockResolvedValue([liveInvite]);

    renderModal();
    expect(listDriveInvitesMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    await screen.findByText(/Editor · 2 of 50 used/);
    expect(listDriveInvitesMock).toHaveBeenCalledWith("team-docs", undefined);
  });

  it("shows a truncated copyable URL without the #k= fragment", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    listDriveInvitesMock.mockResolvedValue([liveInvite]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    const copyBtn = await screen.findByRole("button", { name: "Copy invite link" });
    expect(copyBtn).toHaveTextContent("https://console.example.com/invite/tok_abcd…");
    expect(copyBtn).not.toHaveTextContent("SECRETKEY");
    expect(copyBtn).not.toHaveTextContent("#k=");

    fireEvent.click(copyBtn);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(liveInvite.inviteUrl),
    );
  });

  it("shows a locked stand-in when the blob is present but did not open", async () => {
    listDriveInvitesMock.mockResolvedValue([
      { ...liveInvite, inviteUrl: undefined },
    ]);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(await screen.findByLabelText("Link locked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy invite link" })).not.toBeInTheDocument();
  });

  it("omits the link field on revoked rows", async () => {
    listDriveInvitesMock.mockResolvedValue([
      {
        ...liveInvite,
        revoked: true,
        valid: false,
        linkAvailable: false,
        inviteUrl: undefined,
      },
    ]);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy invite link" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Link locked")).not.toBeInTheDocument();
  });

  // The whole point: a minted link could not be killed at all before this.
  it("revokes a link after the inline confirm, then refetches", async () => {
    listDriveInvitesMock.mockResolvedValue([liveInvite]);
    revokeDriveInviteMock.mockResolvedValue(undefined);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    // One click arms, a second commits -- revoking cannot be undone.
    expect(revokeDriveInviteMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() =>
      expect(revokeDriveInviteMock).toHaveBeenCalledWith("team-docs", "abc123", undefined),
    );
    await waitFor(() => expect(listDriveInvitesMock).toHaveBeenCalledTimes(2));
  });

  it("calls a 100-year expiry what it is", async () => {
    listDriveInvitesMock.mockResolvedValue([liveInvite]);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(await screen.findByText("Never expires")).toBeInTheDocument();
  });

  // A dead link needs no action; a disabled Revoke would imply otherwise.
  it("offers no action on a revoked link, and says why", async () => {
    listDriveInvitesMock.mockResolvedValue([
      { ...liveInvite, revoked: true, valid: false, linkAvailable: false },
    ]);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));

    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("points at the Invite tab when there are no links", async () => {
    listDriveInvitesMock.mockResolvedValue([]);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(await screen.findByText(/No invite links yet/)).toBeInTheDocument();
  });

  it("degrades quietly on a feature-off server", async () => {
    listDriveInvitesMock.mockRejectedValue({
      kind: "NotReady",
      subkind: "SHARED_DRIVES_UNAVAILABLE",
    });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    await waitFor(() => expect(listDriveInvitesMock).toHaveBeenCalled());
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

// A manager may hold a drive they never synced here. The manage calls used to
// resolve a local `sync_paths` row such a drive does not have, and the lenient
// fallback then answers with THIS account's namespace: managing the wrong
// drive rather than failing.
describe("managing a drive that is not synced here", () => {
  const TARGET = { ownerSs58: "5Owner", folderHash: "abc123" };

  function renderUnsynced() {
    const store = createStore();
    store.set(shareDriveModalAtom, {
      label: "team-docs",
      folderName: "team-docs",
      ...TARGET,
    });
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <Provider store={store}>{(<ShareDriveModal />) as ReactNode}</Provider>
      </QueryClientProvider>,
    );
  }

  it("names the owner's drive when listing members", async () => {
    listDriveMembersMock.mockResolvedValue([]);
    renderUnsynced();
    await waitFor(() =>
      expect(listDriveMembersMock).toHaveBeenCalledWith("team-docs", TARGET),
    );
  });

  it("names it when listing links", async () => {
    listDriveMembersMock.mockResolvedValue([]);
    listDriveInvitesMock.mockResolvedValue([]);
    renderUnsynced();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    await waitFor(() =>
      expect(listDriveInvitesMock).toHaveBeenCalledWith("team-docs", TARGET),
    );
  });

  it("names it when removing a member", async () => {
    const member = { memberSs58: MEMBER, role: "writer", createdAt: "" };
    listDriveMembersMock.mockResolvedValue([member]);
    removeDriveMemberMock.mockResolvedValue(undefined);

    renderUnsynced();
    await screen.findByRole("button", { name: "Remove from drive" });
    openMemberMenu(MEMBER, "Remove from drive");
    fireEvent.click(await screen.findByRole("button", { name: /Remove/ }));

    await waitFor(() =>
      expect(removeDriveMemberMock).toHaveBeenCalledWith("team-docs", MEMBER, TARGET),
    );
  });
});

describe("account names", () => {
  it("names a member and the confirmation by display name when the server sent one", async () => {
    const member = {
      memberSs58: MEMBER,
      role: "writer",
      createdAt: "2026-08-20T00:00:00Z",
      memberName: "Grace Hopper",
      memberEmail: "grace@example.com",
    };
    listDriveMembersMock.mockResolvedValue([member]);
    renderModal();
    expect(await screen.findByText("Grace Hopper")).toBeInTheDocument();
    // Email is hover-only.
    expect(screen.queryByText("grace@example.com")).toBeNull();
    openMemberMenu(MEMBER, "Remove from drive");
    expect(await screen.findByText(/Remove Grace Hopper from/)).toBeInTheDocument();
  });
});

describe("mailed invitations on the links tab", () => {
  const mailed = {
    inviteId: "mail1",
    role: "writer",
    expiresAt: "2126-09-12T12:00:00Z",
    maxUses: 1,
    useCount: 0,
    revoked: false,
    valid: true,
    createdAt: "2026-09-17T12:00:00Z",
    recipientEmail: "ada@example.com",
  };

  it("shows who it went to and offers Approve only once they opened it", async () => {
    listDriveMembersMock.mockResolvedValue([]);
    listDriveInvitesMock.mockResolvedValue([
      { ...mailed, emailStatus: "awaiting_seal" },
      { ...mailed, inviteId: "mail2", recipientEmail: "bo@example.com", emailStatus: "sent" },
    ]);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    expect(await screen.findByText(/ada@example.com · Opened, waiting for your approval/)).toBeInTheDocument();
    expect(screen.getByText(/bo@example.com · Sent, not opened yet/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Approve so they can join" })).toHaveLength(1);
  });

  it("approves by id and refetches, so the row moves on", async () => {
    listDriveMembersMock.mockResolvedValue([]);
    listDriveInvitesMock
      .mockResolvedValueOnce([{ ...mailed, emailStatus: "awaiting_seal" }])
      .mockResolvedValueOnce([{ ...mailed, emailStatus: "sealed" }]);
    approveEmailInviteMock.mockResolvedValue({ status: "sealed" });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve so they can join" }));
    await waitFor(() =>
      expect(approveEmailInviteMock).toHaveBeenCalledWith("team-docs", "mail1", undefined),
    );
    expect(await screen.findByText(/Approved, waiting for them to join/)).toBeInTheDocument();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("surfaces a refused approval and re-reads the row", async () => {
    listDriveMembersMock.mockResolvedValue([]);
    listDriveInvitesMock.mockResolvedValue([{ ...mailed, emailStatus: "awaiting_seal" }]);
    approveEmailInviteMock.mockRejectedValue({ kind: "Validation", message: "The invitation changed" });
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve so they can join" }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(listDriveInvitesMock).toHaveBeenCalledTimes(2);
  });
});

describe("folder access with roles (folder roles, staging only)", () => {
  const CAPS = {
    shares: true,
    folder_shares: true,
    folder_share_revoke_by_hash: true,
    share_owner_wrap: true,
    folder_grants: true,
    folder_grant_roles: true,
  };
  const HOLDER = "5HolderAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  function renderWith(target: ShareDriveModalTarget, caps: typeof CAPS | null = CAPS) {
    const store = createStore();
    store.set(serverCapabilitiesAtom, caps);
    store.set(shareDriveModalAtom, target);
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <Provider store={store}>{(<ShareDriveModal />) as ReactNode}</Provider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    folderRolesFlag.on = true;
    listDriveMembersMock.mockResolvedValue([]);
    listDriveFolderGrantsMock.mockResolvedValue([
      { memberSs58: HOLDER, pathPrefix: "Clients/ACME", role: "reader", createdAt: "2026-08-20T00:00:00Z", memberName: "Ada" },
      { memberSs58: HOLDER, pathPrefix: "Clients/Beta", role: "reader", createdAt: "2026-08-21T00:00:00Z" },
    ]);
  });

  afterEach(() => {
    folderRolesFlag.on = false;
  });

  it("shows each holder once, by name, with their role and folders", async () => {
    renderWith({ label: "team-docs", folderName: "team-docs" });
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("Viewer")).toBeInTheDocument();
    expect(screen.getByText(/Clients\/ACME, Clients\/Beta/)).toBeInTheDocument();
  });

  it("changes a holder's role through the grant route", async () => {
    changeFolderGrantRoleMock.mockResolvedValue(undefined);
    renderWith({ label: "team-docs", folderName: "team-docs" });
    await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Change role" }));
    fireEvent.click(screen.getByRole("radio", { name: /Editor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save role" }));
    await waitFor(() =>
      expect(changeFolderGrantRoleMock).toHaveBeenCalledWith("team-docs", HOLDER, "writer", undefined),
    );
  });

  it("offers no role change on a server without folder roles", async () => {
    renderWith({ label: "team-docs", folderName: "team-docs" }, { ...CAPS, folder_grant_roles: false });
    await screen.findByText("Ada");
    expect(screen.queryByRole("button", { name: "Change role" })).not.toBeInTheDocument();
  });

  it("narrows a holder to fewer folders, keeping at least one", async () => {
    replaceFolderGrantsMock.mockResolvedValue(["Clients/ACME"]);
    renderWith({ label: "team-docs", folderName: "team-docs" });
    await screen.findByText("Ada");
    fireEvent.click(screen.getByRole("button", { name: "Change folders" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Clients/Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Save folders" }));
    await waitFor(() =>
      expect(replaceFolderGrantsMock).toHaveBeenCalledWith("team-docs", HOLDER, ["Clients/ACME"], undefined),
    );
  });

  it("from inside a grant, lists only the folder's holders and never the drive's members", async () => {
    const grantLabel = "grant:5Owner~abc~436c69656e7473";
    renderWith({
      label: grantLabel,
      folderName: "Clients",
      ownerSs58: "5Owner",
      folderHash: "abc",
      folderScope: "Clients",
    });
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(listDriveMembersMock).not.toHaveBeenCalled();
    expect(listDriveFolderGrantsMock).toHaveBeenCalledWith(grantLabel, {
      ownerSs58: "5Owner",
      folderHash: "abc",
    });
  });
});
