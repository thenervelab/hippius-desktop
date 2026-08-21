// Render coverage for `SharedWithMeSection`: silence in every non-rows
// state (flag off / loading / unavailable / error / empty), the rows'
// synced-vs-unsynced routing, and the Sync-locally flow (last-browse-dir
// picker → add_shared_drive → verbatim Validation toast).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

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
  it("shows an unsynced membership with owner badge, label, role and Sync locally", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    render(<SharedWithMeSection />);

    await screen.findByText("team-docs");
    expect(screen.getByTestId("avatar")).toHaveAttribute("data-name", OWNER);
    expect(screen.getByText(/writer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync locally" })).toBeInTheDocument();
  });

  it("shows a synced membership's local label with no action button", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([
      membership({ syncedLocally: true, localLabel: "team-docs-2" }),
    ]);
    render(<SharedWithMeSection />);

    await screen.findByText(/Synced as "team-docs-2"/);
    expect(screen.queryByRole("button", { name: "Sync locally" })).not.toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Sync locally" }));

    await waitFor(() =>
      expect(addSharedDriveMock).toHaveBeenCalledWith(OWNER, "0123456789abcdef", "/Users/me/Team", "team-docs"),
    );
    expect(openDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, defaultPath: "/Users/me" }),
    );
    expect(saveLastBrowseDirectoryMock).toHaveBeenCalledWith("/Users/me/Team");
    await waitFor(() => expect(onDriveAdded).toHaveBeenCalledWith("team-docs"));
    await screen.findByText(/Synced as "team-docs"/);
  });

  it("does nothing when the picker is cancelled", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    openDialogMock.mockResolvedValue(null);

    render(<SharedWithMeSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync locally" }));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalled());
    expect(addSharedDriveMock).not.toHaveBeenCalled();
  });

  it("toasts a Validation refusal verbatim — it names the existing label/path", async () => {
    listMyDriveMembershipsMock.mockResolvedValue([membership()]);
    openDialogMock.mockResolvedValue("/Users/me/Elsewhere");
    const message = "This shared drive is already set up as 'team-docs' at /Users/me/Team";
    addSharedDriveMock.mockRejectedValue({ kind: "Validation", message });

    render(<SharedWithMeSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync locally" }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith(message));
  });
});
