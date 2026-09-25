// @vitest-environment jsdom
// What the header says about the drive you are standing in: the badge appears
// on a shared drive and nowhere else, and the owner and a Manager are offered
// the way in to managing access.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";

const listMyDriveMembershipsMock = vi.hoisted(() => vi.fn());
const listOwnedDriveSharingMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/lib/tauri/sharedDrives")
  >();
  return {
    ...actual,
    listMyDriveMemberships: () => listMyDriveMembershipsMock(),
    listOwnedDriveSharing: (...a: unknown[]) => listOwnedDriveSharingMock(...a),
  };
});

const flagState = vi.hoisted(() => ({ on: true }));
const folderRolesFlag = vi.hoisted(() => ({ on: false }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flagState.on;
  },
  get FOLDER_ROLES_ENABLED() {
    return folderRolesFlag.on;
  },
}));

import DriveSharingHeaderMark from "../DriveSharingHeaderMark";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";

const MEMBERSHIP = {
  ownerSs58: "5Owner",
  folderHash: "abc",
  displayLabel: "team-docs",
  role: "writer",
  createdAt: "",
  syncedLocally: true,
  localLabel: "team-docs",
};

function renderMark(
  label: string | null = "team-docs",
  browsedSharedDrive: { ownerSs58: string; folderHash: string } | null = null,
) {
  const store = createStore();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <DriveSharingHeaderMark label={label} displayName="team-docs" browsedSharedDrive={browsedSharedDrive} />
      </Provider>
    </QueryClientProvider>,
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  flagState.on = true;
  listMyDriveMembershipsMock.mockResolvedValue([]);
  listOwnedDriveSharingMock.mockResolvedValue([]);
});

describe("the drive header's sharing mark", () => {
  it("says nothing on a drive that was never shared", async () => {
    renderMark();
    await waitFor(() => expect(listOwnedDriveSharingMock).toHaveBeenCalled());
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
  });

  it("marks an own drive that has been shared, and offers Manage access", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([
      { label: "team-docs", memberCount: 2, liveInviteCount: 0, totalInviteCount: 1 },
    ]);
    renderMark();
    expect(await screen.findByText("Shared with 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage access" })).toBeInTheDocument();
  });

  // Only a drive shared as a whole offers drive-level Manage access. Rust
  // counts whole-drive members and invites only, so a drive where just a
  // folder is shared answers zeros: no drive mark, no drive-level button.
  // The folder carries its own mark and Manage access.
  it("offers no drive-level Manage access when only folders are shared", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([
      { label: "team-docs", memberCount: 0, liveInviteCount: 0, totalInviteCount: 0 },
    ]);
    renderMark();
    await waitFor(() => expect(listOwnedDriveSharingMock).toHaveBeenCalled());
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
  });

  it("offers Manage access on a drive with only a whole-drive invite out", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([
      { label: "team-docs", memberCount: 0, liveInviteCount: 1, totalInviteCount: 1 },
    ]);
    renderMark();
    expect(await screen.findByRole("button", { name: "Manage access" })).toBeInTheDocument();
  });

  // Opening the panel is the point of the button — the badge alone would
  // tell the owner the drive is shared and give them nowhere to go.
  it("opens the manage panel on the drive the header names", async () => {
    listOwnedDriveSharingMock.mockResolvedValue([
      { label: "team-docs", memberCount: 1, liveInviteCount: 0, totalInviteCount: 0 },
    ]);
    const store = renderMark();
    (await screen.findByRole("button", { name: "Manage access" })).click();
    await waitFor(() =>
      expect(store.get(shareDriveModalAtom)).toEqual({
        label: "team-docs",
        folderName: "team-docs",
      }),
    );
  });

  // A Manager gets what the owner gets: the drive's mark, with how many
  // people are in it, and Manage access, which opens the panel through the
  // owner.
  it("gives a Manager the count and Manage access, like the owner", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([{ ...MEMBERSHIP, role: "manager", memberCount: 3 }]);
    const store = renderMark();
    expect(await screen.findByText("Manager")).toBeInTheDocument();
    expect(screen.getByText("Shared with 3")).toBeInTheDocument();
    (await screen.findByRole("button", { name: "Manage access" })).click();
    await waitFor(() => expect(store.get(shareDriveModalAtom)).toMatchObject({ label: "team-docs" }));
    // Their drive is not theirs: the owner-only listing is never asked.
    expect(listOwnedDriveSharingMock).not.toHaveBeenCalled();
  });

  it("names the owner's drive when a Manager browses one not synced here", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([
      { ...MEMBERSHIP, role: "manager", syncedLocally: false, localLabel: null, memberCount: 1 },
    ]);
    const store = renderMark("shared:5Owner~abc", { ownerSs58: "5Owner", folderHash: "abc" });
    expect(await screen.findByText("Shared with 1")).toBeInTheDocument();
    (await screen.findByRole("button", { name: "Manage access" })).click();
    await waitFor(() =>
      expect(store.get(shareDriveModalAtom)).toMatchObject({ ownerSs58: "5Owner", folderHash: "abc" }),
    );
  });

  it("gives a Manager no count mark when the listing does not say", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([{ ...MEMBERSHIP, role: "manager" }]);
    renderMark();
    expect(await screen.findByRole("button", { name: "Manage access" })).toBeInTheDocument();
    expect(screen.queryByText(/Shared with/)).not.toBeInTheDocument();
  });

  // A Viewer or an Editor sees whose drive it is and what they may do in it,
  // and no Manage access.
  it.each([
    ["writer", "Editor"],
    ["reader", "Viewer"],
  ])("shows a %s their role and no Manage access or count", async (role, chip) => {
    listMyDriveMembershipsMock.mockResolvedValue([{ ...MEMBERSHIP, role, memberCount: 3 }]);
    renderMark();
    expect(await screen.findByText(chip)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Who has access" })).toBeInTheDocument();
    expect(screen.queryByText("Shared with 3")).not.toBeInTheDocument();
  });

  it("shows a member their role and no Manage access", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([MEMBERSHIP]);
    renderMark();
    // A drive shared WITH you is described by the ROLE, in the console's
    // colour-coded chip: that is the useful fact, and "Shared" is already
    // obvious from the section it sits in.
    expect(await screen.findByText("Editor")).toBeInTheDocument();
    expect(screen.queryByText(/Shared ·/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
  });

  // The same panel opens read only for them: who else is in the drive, and
  // the way to leave it.
  it("lets a member see who has access, in the same panel", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([MEMBERSHIP]);
    const store = renderMark();
    (await screen.findByRole("button", { name: "Who has access" })).click();
    await waitFor(() => expect(store.get(shareDriveModalAtom)).toMatchObject({ label: "team-docs" }));
  });

  // Asking the owner-only listing about somebody else's drive is a refusal
  // waiting to happen, so it is never asked.
  it("never asks the owner-only listing about a member drive", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([MEMBERSHIP]);
    renderMark();
    await screen.findByText("Editor");
    expect(listOwnedDriveSharingMock).not.toHaveBeenCalled();
  });

  it("renders nothing on the folder list, where no drive is open", () => {
    renderMark(null);
    expect(listOwnedDriveSharingMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });

  it("renders nothing while the feature is off", () => {
    flagState.on = false;
    renderMark();
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });
});
