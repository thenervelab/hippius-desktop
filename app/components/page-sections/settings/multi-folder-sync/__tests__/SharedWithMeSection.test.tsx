// Render coverage for `SharedWithMeSection`: silence in every non-rows
// state (flag off / loading / unavailable / error / empty), the rows'
// synced-vs-unsynced routing, and the Sync-locally flow (last-browse-dir
// picker → add_shared_drive → verbatim Validation toast).

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rtlRender, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import "@testing-library/jest-dom";

// The overflow menu is Radix-backed and does not open under jsdom. These
// tests are about what the row OFFERS and what pressing it does, not about
// Radix, so the shell renders its items as plain buttons.
const listSharedDriveStatsMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/hooks/useSharedDriveStats", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/app/lib/hooks/useSharedDriveStats")
  >();
  return {
    ...actual,
    useSharedDriveStats: () => listSharedDriveStatsMock(),
  };
});

vi.mock("@/components/ui/alt-table/TableActionMenu", () => ({
  __esModule: true,
  default: ({
    items,
    children,
  }: {
    items: { itemTitle: React.ReactNode; onItemClick?: () => void; disabled?: boolean }[];
    children: React.ReactNode;
  }) => (
    <div>
      {children}
      {/* The real menu PORTALS its items out of the row, so a click on one
          never travels through the row's own open handler. Rendered inline
          here, they would — `row-action-area` stands in for the portal. */}
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          className="row-action-area"
          disabled={item.disabled}
          onClick={() => item.onItemClick?.()}
        >
          {item.itemTitle}
        </button>
      ))}
    </div>
  ),
}));

import { SharedWithMeSection } from "../SharedWithMeSection";

// The section asks the owners' listings for each drive's size and counts, so
// it reads the query client.
const render = (ui: React.ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );

import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";

const flagState = vi.hoisted(() => ({ sharedDrivesEnabled: true }));
const folderRolesFlag = vi.hoisted(() => ({ on: false }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flagState.sharedDrivesEnabled;
  },
  get FOLDER_ROLES_ENABLED() {
    return folderRolesFlag.on;
  },
}));

const listMyDriveMembershipsMock = vi.fn();
const addSharedDriveMock = vi.fn();
const listMyFolderGrantsMock = vi.fn().mockResolvedValue([]);
const leaveSharedDriveByIdentityMock = vi.fn();
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    listMyDriveMemberships: (...args: unknown[]) => listMyDriveMembershipsMock(...args),
    addSharedDrive: (...args: unknown[]) => addSharedDriveMock(...args),
    listMyFolderGrants: (...args: unknown[]) => listMyFolderGrantsMock(...args),
    leaveSharedDriveByIdentity: (...args: unknown[]) =>
      leaveSharedDriveByIdentityMock(...args),
  };
});

const openDialogMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
}));

const getLastBrowseDirectoryMock = vi.fn();
const saveLastBrowseDirectoryMock = vi.fn();
vi.mock("@/app/lib/utils/userPreferencesDb", () => ({
  getLastBrowseDirectory: (...args: unknown[]) => getLastBrowseDirectoryMock(...args),
  saveLastBrowseDirectory: (...args: unknown[]) => saveLastBrowseDirectoryMock(...args),
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = ({ name }: { name?: string }) => <span data-testid="avatar" data-name={name} />;
    Stub.displayName = "AvatarStub";
    return Stub;
  },
}));

const OWNER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const UNAVAILABLE = { kind: "NotReady", subkind: "SHARED_DRIVES_UNAVAILABLE", message: "off" };

function membership(overrides: Partial<DriveMembershipInfo> = {}): DriveMembershipInfo {
  return {
    ownerSs58: OWNER,
    folderHash: "0123456789abcdef",
    displayLabel: "team-docs",
    role: "writer",
    createdAt: "2026-08-20T00:00:00Z",
    syncedLocally: false,
    localLabel: null,
    ...overrides,
  };
}

beforeEach(() => {
  listSharedDriveStatsMock.mockReturnValue(new Map());
  vi.clearAllMocks();
  flagState.sharedDrivesEnabled = true;
  getLastBrowseDirectoryMock.mockResolvedValue("/Users/me");
  saveLastBrowseDirectoryMock.mockResolvedValue(undefined);
});

describe("silent non-rows states", () => {
  it("renders nothing while the flag is off — the fetch never even fires", () => {
    flagState.sharedDrivesEnabled = false;
    const { container } = render(<SharedWithMeSection />);
    expect(container).toBeEmptyDOMElement();
    expect(listMyDriveMembershipsMock).not.toHaveBeenCalled();
  });

  it("renders nothing while loading", () => {
    listMyDriveMembershipsMock.mockReturnValue(new Promise(() => undefined));
    const { container } = render(<SharedWithMeSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing on a feature-off server, without a toast", async () => {
    listMyDriveMembershipsMock.mockRejectedValue(UNAVAILABLE);
    const { container } = render(<SharedWithMeSection />);
    await waitFor(() => expect(listMyDriveMembershipsMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("renders nothing on a real fetch error, without a toast (passive mount fetch)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    listMyDriveMembershipsMock.mockRejectedValue({ kind: "Hcfs", message: "boom" });
    const { container } = render(<SharedWithMeSection />);
    await waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(toastErrorMock).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("renders nothing with zero memberships", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([]);
    const { container } = render(<SharedWithMeSection />);
    await waitFor(() => expect(listMyDriveMembershipsMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe("rows", () => {
  it("shows an unsynced membership as a folder with its label, role and actions", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection />);

    await screen.findByText("team-docs");
    // The owner's identicon used to sit here, which made a shared drive look
    // like a person rather than a place for files. The owner is named on the
    // line below instead.
    expect(screen.queryByTestId("avatar")).not.toBeInTheDocument();
    // The label people read, never the wire word: this row used to print
    // "writer" straight from the membership.
    expect(screen.getByText(/Editor/)).toBeInTheDocument();
    expect(screen.queryByText(/writer/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync to this computer" })).toBeInTheDocument();
  });

  it("shows a synced membership's local label with no action button", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([
      membership({ syncedLocally: true, localLabel: "team-docs-2" }),
    ]);
    render(<SharedWithMeSection />);

    await screen.findByText(/Synced here/);
    // Already here: syncing again would either no-op or re-install it at a
    // new path, and neither is what the word promises.
    expect(screen.queryByRole("button", { name: "Sync to this computer" })).not.toBeInTheDocument();
  });
});

// A Manager manages the drive for its owner from this row, as an owner does
// from theirs: a Manage access button and the same item in the row's menu.
// A Viewer or an Editor gets neither.
describe("managing access from a shared drive's row", () => {
  it("gives a Manager Manage access on the row and in its menu, naming the owner's drive", async () => {
    const onManageAccess = vi.fn();
    const onOpenDrive = vi.fn();
    listMyDriveMembershipsMock.mockResolvedValue([membership({ role: "manager" })]);
    render(<SharedWithMeSection onManageAccess={onManageAccess} onOpenDrive={onOpenDrive} />);

    const buttons = await screen.findAllByRole("button", { name: "Manage access" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);
    expect(onManageAccess).toHaveBeenCalledTimes(2);
    expect(onManageAccess).toHaveBeenCalledWith({
      label: "team-docs",
      folderName: "team-docs",
      ownerSs58: OWNER,
      folderHash: "0123456789abcdef",
    });
    // Pressing it manages; it never also opens the drive behind the panel.
    expect(onOpenDrive).not.toHaveBeenCalled();
  });

  it("opens a synced drive by its local label", async () => {
    const onManageAccess = vi.fn();
    listMyDriveMembershipsMock.mockResolvedValue([
      membership({ role: "manager", syncedLocally: true, localLabel: "team-docs-2" }),
    ]);
    render(<SharedWithMeSection onManageAccess={onManageAccess} />);

    fireEvent.click((await screen.findAllByRole("button", { name: "Manage access" }))[0]);
    expect(onManageAccess).toHaveBeenCalledWith({ label: "team-docs-2", folderName: "team-docs" });
  });

  it.each(["writer", "reader", "admin"])("offers a %s no Manage access", async (role) => {
    listMyDriveMembershipsMock.mockResolvedValue([membership({ role })]);
    render(<SharedWithMeSection onManageAccess={vi.fn()} />);

    await screen.findByText("team-docs");
    expect(screen.queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave drive" })).toBeInTheDocument();
  });
});

describe("sync locally", () => {
  it("routes picker → add_shared_drive → onDriveAdded, remembering the browse dir", async () => {
    listMyDriveMembershipsMock
      .mockResolvedValueOnce([membership()])
      .mockResolvedValueOnce([membership({ syncedLocally: true, localLabel: "team-docs" })]);
    openDialogMock.mockResolvedValue("/Users/me/Team");
    addSharedDriveMock.mockResolvedValue({ label: "team-docs" });
    const onDriveAdded = vi.fn();

    render(<SharedWithMeSection onDriveAdded={onDriveAdded} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync to this computer" }));

    await waitFor(() =>
      expect(addSharedDriveMock).toHaveBeenCalledWith(OWNER, "0123456789abcdef", "/Users/me/Team", "team-docs"),
    );
    expect(openDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, defaultPath: "/Users/me" }),
    );
    expect(saveLastBrowseDirectoryMock).toHaveBeenCalledWith("/Users/me/Team");
    await waitFor(() => expect(onDriveAdded).toHaveBeenCalledWith("team-docs"));
    await screen.findByText(/Synced here/);
  });

  it("does nothing when the picker is cancelled", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    openDialogMock.mockResolvedValue(null);

    render(<SharedWithMeSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync to this computer" }));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalled());
    expect(addSharedDriveMock).not.toHaveBeenCalled();
  });

  it("toasts a Validation refusal verbatim — it names the existing label/path", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    openDialogMock.mockResolvedValue("/Users/me/Elsewhere");
    const message = "This shared drive is already set up as 'team-docs' at /Users/me/Team";
    addSharedDriveMock.mockRejectedValue({ kind: "Validation", message });

    render(<SharedWithMeSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync to this computer" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(message));
  });
});

// Looking at what somebody shared with you used to require copying it to
// this machine first: "Sync locally" was the row's only action. Browsing
// needs no local copy and no folder key — /browse authorises any member of
// the drive and returns names and paths in plaintext.
describe("opening a shared drive without syncing it", () => {
  it("opens the drive by its wire identity when the row is clicked", async () => {
    const onOpenDrive = vi.fn();
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection onOpenDrive={onOpenDrive} />);

    fireEvent.click(await screen.findByText("team-docs"));
    expect(onOpenDrive).toHaveBeenCalledWith(
      expect.objectContaining({ ownerSs58: OWNER, displayLabel: "team-docs" }),
    );
  });

  // The row's own control must not also open the drive behind the dialog it
  // raises — the classic nested-affordance mis-click.
  it("does not open the drive when a menu action is pressed", async () => {
    const onOpenDrive = vi.fn();
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection onOpenDrive={onOpenDrive} />);

    fireEvent.click(await screen.findByRole("button", { name: /Sync to this computer/ }));
    expect(onOpenDrive).not.toHaveBeenCalled();
  });

  it("is reachable from the keyboard", async () => {
    const onOpenDrive = vi.fn();
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection onOpenDrive={onOpenDrive} />);

    const row = await screen.findByRole("button", { name: "Open team-docs" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenDrive).toHaveBeenCalledTimes(1);
  });

  // Settings has nowhere to browse to, so the row stays a plain row there.
  it("stays inert on a surface that cannot browse", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection />);
    await screen.findByText("team-docs");
    expect(screen.queryByRole("button", { name: /Open team-docs/ })).not.toBeInTheDocument();
  });
});

// The membership listing carries no counts, so a row starts with nothing to
// show and only the OWNER's listing can correct it. Rendering an uncorrected
// row as "0 B - 0 files" claims a drive is empty when nobody successfully
// asked, which is the failure nobody files a bug for.
describe("a shared drive's size and counts", () => {
  it("shows them once the owner's listing has answered", async () => {
    listSharedDriveStatsMock.mockReturnValue(
      new Map([
        [
          `${OWNER}:0123456789abcdef`,
          {
            ownerSs58: OWNER,
            folderHash: "0123456789abcdef",
            fileCount: 5,
            totalBytes: 5_890_000,
            updatedAt: 1_789_000_000,
          },
        ],
      ]),
    );
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection />);

    await screen.findByText("team-docs");
    expect(screen.getByText((_t, el) => el?.textContent?.trim() === "5 files")).toBeInTheDocument();
    expect(screen.getByText(/MB/)).toBeInTheDocument();
  });

  it("shows nothing at all while the drive's size is unknown", async () => {
    listSharedDriveStatsMock.mockReturnValue(new Map());
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection />);

    await screen.findByText("team-docs");
    // Never "0 B" or "0 files": an unknown is not an empty drive.
    expect(screen.queryByText((_t, el) => el?.textContent?.trim() === "0 files")).not.toBeInTheDocument();
    expect(screen.queryByText(/^0 B$/)).not.toBeInTheDocument();
  });

  // A drive that really is empty has answered, and says so.
  it("says zero for a drive the owner's listing reports as empty", async () => {
    listSharedDriveStatsMock.mockReturnValue(
      new Map([
        [
          `${OWNER}:0123456789abcdef`,
          {
            ownerSs58: OWNER,
            folderHash: "0123456789abcdef",
            fileCount: 0,
            totalBytes: 0,
            updatedAt: 0,
          },
        ],
      ]),
    );
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection />);

    await screen.findByText("team-docs");
    expect(screen.getByText((_t, el) => el?.textContent?.trim() === "0 files")).toBeInTheDocument();
  });
});

describe("folders shared with me (folder roles)", () => {
  const CAPS = {
    shares: true,
    folder_shares: true,
    folder_share_revoke_by_hash: true,
    share_owner_wrap: true,
    folder_grants: true,
    folder_grant_writes: true,
  };
  const GRANT = {
    ownerSs58: OWNER,
    ownerName: "Grace",
    folderHash: "0123456789abcdef",
    displayLabel: "team-docs",
    pathPrefix: "Clients/ACME",
    role: "writer",
    createdAt: "2026-08-20T00:00:00Z",
  };

  beforeEach(() => {
    folderRolesFlag.on = true;
    getDefaultStore().set(serverCapabilitiesAtom, CAPS);
    listMyDriveMembershipsMock.mockResolvedValue([]);
    listMyFolderGrantsMock.mockResolvedValue([GRANT]);
  });

  afterEach(() => {
    folderRolesFlag.on = false;
    getDefaultStore().set(serverCapabilitiesAtom, null);
  });

  it("lists a shared folder as its own row, naming its drive and owner", async () => {
    render(<SharedWithMeSection />);
    expect(await screen.findByText("ACME")).toBeInTheDocument();
    expect(screen.getByText("In team-docs")).toBeInTheDocument();
    expect(screen.getByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("Editor")).toBeInTheDocument();
    // Never offered: syncing a granted folder to disk is out of scope.
    expect(screen.queryByText("Sync to this computer")).not.toBeInTheDocument();
  });

  it("opens the folder rooted at itself", async () => {
    const onOpenFolderGrant = vi.fn();
    render(<SharedWithMeSection onOpenFolderGrant={onOpenFolderGrant} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open ACME" }));
    expect(onOpenFolderGrant).toHaveBeenCalledWith({
      ownerSs58: OWNER,
      folderHash: "0123456789abcdef",
      pathPrefix: "Clients/ACME",
      folderName: "ACME",
    });
  });

  // Manager is not a folder role (HCFS #475): a holder never manages the
  // folder, whatever role the listing claims.
  it("offers no Manage access on a shared folder", async () => {
    listMyFolderGrantsMock.mockResolvedValue([{ ...GRANT, role: "manager" }]);
    render(<SharedWithMeSection onManageAccess={vi.fn()} />);
    await screen.findByText("ACME");
    expect(screen.queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
  });

  it("leaves the folder after a confirmation", async () => {
    leaveSharedDriveByIdentityMock.mockResolvedValue(undefined);
    render(<SharedWithMeSection />);
    await screen.findByText("ACME");
    // The row menu's item opens the confirmation; nothing is left yet.
    fireEvent.click(screen.getByRole("button", { name: "Leave folder" }));
    expect(leaveSharedDriveByIdentityMock).not.toHaveBeenCalled();
    const buttons = await screen.findAllByRole("button", { name: "Leave folder" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() =>
      expect(leaveSharedDriveByIdentityMock).toHaveBeenCalledWith(OWNER, "0123456789abcdef"),
    );
  });
});
