// Render coverage for `SharedWithMeSection`: silence in every non-rows
// state (flag off / loading / unavailable / error / empty), the rows'
// synced-vs-unsynced routing, and the Sync-locally flow (last-browse-dir
// picker → add_shared_drive → verbatim Validation toast).

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

// The overflow menu is Radix-backed and does not open under jsdom. These
// tests are about what the row OFFERS and what pressing it does, not about
// Radix, so the shell renders its items as plain buttons.
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
import type { DriveMembershipInfo } from "@/app/lib/tauri/sharedDrives";

const flagState = vi.hoisted(() => ({ sharedDrivesEnabled: true }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flagState.sharedDrivesEnabled;
  },
}));

const listMyDriveMembershipsMock = vi.fn();
const addSharedDriveMock = vi.fn();
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    listMyDriveMemberships: (...args: unknown[]) => listMyDriveMembershipsMock(...args),
    addSharedDrive: (...args: unknown[]) => addSharedDriveMock(...args),
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
