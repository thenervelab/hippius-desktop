// State coverage for `ShareDriveModal` (owner invite mint + members
// management): flag OFF renders nothing; the invite machine's
// choosing → running → done (auto-copy) and → error / unavailable
// terminals; the members tab's loading / rows / empty / unavailable
// views and the two-step remove.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

import ShareDriveModal from "../ShareDrivePanel";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";

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
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flagState.sharedDrivesEnabled;
  },
}));

// The modal's only side effects are the sharedDrives wrappers; mocking the
// wrapper module (not raw invoke) keeps the tests on the modal's contract.
const createDriveInviteMock = vi.fn();
const listDriveMembersMock = vi.fn();
const removeDriveMemberMock = vi.fn();
const changeDriveMemberRoleMock = vi.fn();
const listDriveInvitesMock = vi.fn();
const revokeDriveInviteMock = vi.fn();

/** A stable member address, so the role assertions read for themselves. */
const MEMBER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    createDriveInvite: (...args: unknown[]) => createDriveInviteMock(...args),
    listDriveMembers: (...args: unknown[]) => listDriveMembersMock(...args),
    removeDriveMember: (...args: unknown[]) => removeDriveMemberMock(...args),
    changeDriveMemberRole: (...args: unknown[]) =>
      changeDriveMemberRoleMock(...args),
    listDriveInvites: (...args: unknown[]) => listDriveInvitesMock(...args),
    revokeDriveInvite: (...args: unknown[]) => revokeDriveInviteMock(...args),
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
  return render(<Provider store={store}>{(<ShareDriveModal />) as ReactNode}</Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  flagState.sharedDrivesEnabled = true;
});



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
    expect(listDriveMembersMock).toHaveBeenCalledWith("team-docs");
  });

  it("offers every role in the picker, selecting the member's current one", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "writer", createdAt: "2026-08-20T00:00:00Z" },
    ]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    const picker = (await screen.findByRole("combobox")) as HTMLSelectElement;

    expect(picker.value).toBe("writer");
    expect(
      Array.from(picker.options).map((o) => o.textContent),
    ).toEqual(["Viewer", "Editor", "Manager"]);
  });

  it("changes a role and refetches, so the row reflects the server", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "writer", createdAt: "2026-08-20T00:00:00Z" },
    ]);
    changeDriveMemberRoleMock.mockResolvedValue(undefined);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    const picker = await screen.findByRole("combobox");

    fireEvent.change(picker, { target: { value: "manager" } });

    await waitFor(() =>
      expect(changeDriveMemberRoleMock).toHaveBeenCalledWith(
        "team-docs",
        MEMBER,
        "manager",
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
    const picker = await screen.findByRole("combobox");
    fireEvent.change(picker, { target: { value: "reader" } });

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("You cannot change your own role"),
      ),
    );
  });

  it("hides the role picker while a removal is being confirmed", async () => {
    listDriveMembersMock.mockResolvedValue([
      { memberSs58: MEMBER, role: "reader", createdAt: "2026-08-20T00:00:00Z" },
    ]);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    // Two destructive-ish controls side by side invite a mis-click on the one
    // the user was not looking at.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Confirm remove" }),
    ).toBeInTheDocument();
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

  it("removes a member only after the inline confirm, then refetches", async () => {
    const member = {
      memberSs58: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
      role: "writer",
      createdAt: "2026-08-20T00:00:00Z",
    };
    listDriveMembersMock.mockResolvedValueOnce([member]).mockResolvedValueOnce([]);
    removeDriveMemberMock.mockResolvedValue(undefined);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    const removeButton = await screen.findByRole("button", { name: "Remove" });

    // First click arms; nothing is removed yet.
    fireEvent.click(removeButton);
    expect(removeDriveMemberMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() =>
      expect(removeDriveMemberMock).toHaveBeenCalledWith("team-docs", member.memberSs58),
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
  };

  it("lists links only when the tab is opened", async () => {
    listDriveInvitesMock.mockResolvedValue([liveInvite]);

    renderModal();
    expect(listDriveInvitesMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Links" }));
    await screen.findByText(/Editor · 2 of 50 used/);
    expect(listDriveInvitesMock).toHaveBeenCalledWith("team-docs");
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
      expect(revokeDriveInviteMock).toHaveBeenCalledWith("team-docs", "abc123"),
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
      { ...liveInvite, revoked: true, valid: false },
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
