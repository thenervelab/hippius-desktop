// @vitest-environment jsdom
// What the header says about the drive you are standing in: the badge appears
// on a shared drive and nowhere else, and only an owner is offered the way in
// to managing access.
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

function renderMark(label: string | null = "team-docs") {
  const store = createStore();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <DriveSharingHeaderMark label={label} displayName="team-docs" />
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

  // A member sees whose drive it is and what they may do in it. Managing
  // access is the owner's business, and the IPC would refuse them anyway.
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
