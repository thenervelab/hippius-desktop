// @vitest-environment jsdom
// The mark on a folder shared on its own: on that folder's row and header,
// never on the folder around it, never for somebody else's drive, and a way
// in to Manage access scoped to the folder.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider, createStore } from "jotai";

const listMyDriveMembershipsMock = vi.hoisted(() => vi.fn());
const listOwnedFolderSharingMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...actual,
    listMyDriveMemberships: () => listMyDriveMembershipsMock(),
    listOwnedFolderSharing: (...a: unknown[]) =>
      listOwnedFolderSharingMock(...a),
  };
});

const flagState = vi.hoisted(() => ({ on: true }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flagState.on;
  },
  FOLDER_ROLES_ENABLED: false,
}));

import FolderSharingMark, {
  FolderSharingHeaderMark,
} from "../FolderSharingMark";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { OWNED_FOLDER_SHARING_QUERY_KEY } from "@/app/lib/hooks/useOwnedFolderSharing";
import { invalidateOwnedDriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";

const SHARED = [
  { path: "Clients/ACME", holderCount: 2, hasInvite: true },
  { path: "Photos", holderCount: 0, hasInvite: true },
];

function renderWith(ui: React.ReactElement) {
  const store = createStore();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Provider store={store}>{ui}</Provider>
    </QueryClientProvider>,
  );
  return { store, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  flagState.on = true;
  listMyDriveMembershipsMock.mockResolvedValue([]);
  listOwnedFolderSharingMock.mockResolvedValue(SHARED);
});

describe("the folder row's sharing mark", () => {
  it("counts the people who hold the folder, with the on-its-own tooltip", async () => {
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients/ACME"
        folderName="ACME"
      />,
    );
    const mark = await screen.findByRole("button", {
      name: "Shared with 2. Manage access to this folder",
    });
    expect(mark).toHaveTextContent("Shared with 2");
    expect(mark).toHaveAttribute(
      "title",
      "Shared on its own with 2 people. The rest of the drive isn't.",
    );
    expect(listOwnedFolderSharingMock).toHaveBeenCalledWith("team");
  });

  it("says Shared on a folder with only an invite out", async () => {
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="/Photos/"
        folderName="Photos"
      />,
    );
    expect(await screen.findByText("Shared")).toBeInTheDocument();
  });

  // A grant on Clients/ACME marks ACME while browsing Clients, and nothing
  // on Clients itself.
  it("marks nothing on the folder around a shared one", async () => {
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients"
        folderName="Clients"
      />,
    );
    await waitFor(() => expect(listOwnedFolderSharingMock).toHaveBeenCalled());
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });

  it("opens Manage access scoped to the folder, without opening the folder", async () => {
    const onRowClick = vi.fn();
    const { store } = renderWith(
      <div onClick={onRowClick}>
        <FolderSharingMark
          label="team"
          folderPath="Clients/ACME"
          folderName="ACME"
        />
      </div>,
    );
    fireEvent.click(await screen.findByText("Shared with 2"));
    expect(store.get(shareDriveModalAtom)).toEqual({
      label: "team",
      folderName: "ACME",
      pathPrefix: "Clients/ACME",
    });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  // Its own way in, beside the pill: the same folder-scoped panel, named for
  // the folder, and it does not open the folder either.
  it("has a Manage access button that opens the folder's panel", async () => {
    const onRowClick = vi.fn();
    const { store } = renderWith(
      <div onClick={onRowClick}>
        <FolderSharingMark
          label="team"
          folderPath="Clients/ACME"
          folderName="ACME"
        />
      </div>,
    );
    const button = await screen.findByRole("button", {
      name: "Manage access for ACME",
    });
    // Words where the name cell is wide, an icon where it is narrow.
    expect(button).toHaveTextContent("Manage access");
    fireEvent.click(button);
    expect(store.get(shareDriveModalAtom)).toEqual({
      label: "team",
      folderName: "ACME",
      pathPrefix: "Clients/ACME",
    });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("opens it from the keyboard", async () => {
    const { store } = renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients/ACME"
        folderName="ACME"
      />,
    );
    fireEvent.keyDown(
      await screen.findByRole("button", { name: "Manage access for ACME" }),
      { key: "Enter" },
    );
    expect(store.get(shareDriveModalAtom)).toMatchObject({
      pathPrefix: "Clients/ACME",
    });
  });

  it("offers no Manage access on a folder that is not shared on its own", async () => {
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients"
        folderName="Clients"
      />,
    );
    await waitFor(() => expect(listOwnedFolderSharingMock).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /Manage access/ }),
    ).not.toBeInTheDocument();
  });

  it("shows only the icon and the count in the card view", async () => {
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients/ACME"
        folderName="ACME"
        compact
      />,
    );
    const mark = await screen.findByRole("button", {
      name: "Shared with 2. Manage access to this folder",
    });
    expect(mark).toHaveTextContent(/^2$/);
    // The card's button is an icon, named for the folder.
    expect(
      screen.getByRole("button", { name: "Manage access for ACME" }),
    ).toHaveTextContent(/^$/);
  });

  // The listing is the owner's. Somebody else's drive is never asked about.
  it("never asks about a drive shared with this account", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([
      {
        ownerSs58: "5Owner",
        folderHash: "abc",
        displayLabel: "team",
        role: "writer",
        createdAt: "",
        syncedLocally: true,
        localLabel: "team",
      },
    ]);
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients/ACME"
        folderName="ACME"
      />,
    );
    await waitFor(() => expect(listMyDriveMembershipsMock).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(listOwnedFolderSharingMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });

  it("draws nothing while the listing fails", async () => {
    listOwnedFolderSharingMock.mockRejectedValue(new Error("offline"));
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients/ACME"
        folderName="ACME"
      />,
    );
    await waitFor(() => expect(listOwnedFolderSharingMock).toHaveBeenCalled());
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
  });

  it("renders nothing while the feature is off", () => {
    flagState.on = false;
    renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients/ACME"
        folderName="ACME"
      />,
    );
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
    expect(listOwnedFolderSharingMock).not.toHaveBeenCalled();
  });

  // Every mutation that refreshes the drive mark refreshes the folder marks.
  it("is refreshed by the drive mark's invalidation", async () => {
    const { client } = renderWith(
      <FolderSharingMark
        label="team"
        folderPath="Clients/ACME"
        folderName="ACME"
      />,
    );
    await screen.findByText("Shared with 2");
    listOwnedFolderSharingMock.mockResolvedValue([]);
    await invalidateOwnedDriveSharing(client);
    await waitFor(() =>
      expect(screen.queryByText(/Shared/)).not.toBeInTheDocument(),
    );
    expect(
      client.getQueryState([OWNED_FOLDER_SHARING_QUERY_KEY, "team"])
        ?.dataUpdateCount,
    ).toBe(2);
  });
});

describe("the open folder's header mark", () => {
  it("marks a folder shared on its own and opens its Manage access", async () => {
    const { store } = renderWith(
      <FolderSharingHeaderMark label="team" folderPath="Clients/ACME" />,
    );
    expect(await screen.findByText("Shared with 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage access" }));
    expect(store.get(shareDriveModalAtom)).toEqual({
      label: "team",
      folderName: "ACME",
      pathPrefix: "Clients/ACME",
    });
  });

  it("says nothing inside a folder that is not itself shared", async () => {
    renderWith(<FolderSharingHeaderMark label="team" folderPath="Clients" />);
    await waitFor(() => expect(listOwnedFolderSharingMock).toHaveBeenCalled());
    expect(screen.queryByText(/Shared/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage access" }),
    ).not.toBeInTheDocument();
  });
});
