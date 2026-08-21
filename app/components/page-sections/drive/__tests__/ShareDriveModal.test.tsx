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

import ShareDriveModal from "../ShareDriveModal";
import { shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";

// Flip the flag per test — the modal reads it at render time.
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
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    createDriveInvite: (...args: unknown[]) => createDriveInviteMock(...args),
    listDriveMembers: (...args: unknown[]) => listDriveMembersMock(...args),
    removeDriveMember: (...args: unknown[]) => removeDriveMemberMock(...args),
  };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

const UNAVAILABLE = { kind: "NotReady", subkind: "SHARED_DRIVES_UNAVAILABLE", message: "off" };

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return { writeText };
}

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

describe("invite tab", () => {
  it("mints with the chosen defaults and lands on done with an auto-copied URL", async () => {
    const { writeText } = installClipboard();
    createDriveInviteMock.mockResolvedValue({
      inviteUrl: "https://console.example.com/invite/tok#k=abc",
    });

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    expect(createDriveInviteMock).toHaveBeenCalledWith("team-docs", {
      expiresInSecs: 7 * 24 * 60 * 60,
    });
    await screen.findByDisplayValue("https://console.example.com/invite/tok#k=abc");
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://console.example.com/invite/tok#k=abc"),
    );
    // The caption points revocation at the Members tab (there is no invite
    // revoke surface in v1 by design).
    expect(screen.getByText(/until it expires/)).toBeInTheDocument();
  });

  it("surfaces a mint failure inline with a retry back to choosing", async () => {
    installClipboard();
    createDriveInviteMock.mockRejectedValue({ kind: "Hcfs", message: "server exploded" });

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    await screen.findByText("Couldn't create invite link");
    expect(screen.getByText("server exploded")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeInTheDocument();
  });

  it("degrades quietly on a feature-off server — no error styling, no retry", async () => {
    installClipboard();
    createDriveInviteMock.mockRejectedValue(UNAVAILABLE);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    await screen.findByText(/aren't available on your server yet/);
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});

describe("members tab", () => {
  it("lazily loads members on tab activation and renders rows", async () => {
    listDriveMembersMock.mockResolvedValue([
      {
        memberSs58: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
        role: "writer",
        createdAt: "2026-08-20T00:00:00Z",
      },
    ]);

    renderModal();
    expect(listDriveMembersMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    await screen.findByText(/writer/);
    expect(listDriveMembersMock).toHaveBeenCalledWith("team-docs");
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
