// The invite mint, which is a dialog rather than a panel tab (owner mint
// management): flag OFF renders nothing; the invite machine's
// choosing → running → done (auto-copy) and → error / unavailable
// terminals; the members tab's loading / rows / empty / unavailable
// views and the two-step remove.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import CreateDriveInviteDialog from "../CreateDriveInviteDialog";
import { createDriveInviteDialogAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { BILLING_ROUTE } from "@/app/lib/routes";

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
const NOT_ENTITLED = {
  kind: "NotReady",
  subkind: "SHARED_DRIVES_NOT_ENTITLED",
  message: "Shared drives need a Plus, Max, or Scale plan",
};

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return { writeText };
}

function renderModal(target: { label: string; folderName: string } | null = { label: "team-docs", folderName: "team-docs" }) {
  const store = createStore();
  store.set(createDriveInviteDialogAtom, target);
  // The surface invalidates the drive list's sharing query on a mutation,
  // so it reads the query client.
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>{(<CreateDriveInviteDialog />) as ReactNode}</Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  flagState.sharedDrivesEnabled = true;
});


/** Drive the custom Select: open by its aria-label, then click the option. */
function chooseRole(optionLabel: string) {
  fireEvent.click(screen.getByLabelText("Invite role"));
  fireEvent.click(screen.getByText(optionLabel));
}


describe("create invite dialog", () => {
  it("mints with the chosen defaults and lands on done with an auto-copied URL", async () => {
    const { writeText } = installClipboard();
    createDriveInviteMock.mockResolvedValue({
      inviteUrl: "https://console.example.com/invite/tok#k=abc",
    });

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    expect(createDriveInviteMock).toHaveBeenCalledWith("team-docs", {
      expiresInSecs: 7 * 24 * 60 * 60,
      // `writer` is the historical default, so an untouched form mints
      // exactly what every build before the picker did.
      role: "writer",
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

  it("shows an upgrade prompt when the owner's plan cannot mint — no error, no retry", async () => {
    installClipboard();
    createDriveInviteMock.mockRejectedValue(NOT_ENTITLED);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    await screen.findByText(/Shared drives need Plus, Max, or Scale/);
    // An upgrade state, not an error: no generic error copy, no retry.
    expect(screen.queryByText("Couldn't create invite link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    // The same in-app destination every other Drive upgrade prompt uses, so
    // the user is never sent to the console for a plan the app can change.
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
  });

  it("mints as Editor by default, which is what every prior build minted", async () => {
    createDriveInviteMock.mockResolvedValue({ inviteUrl: "https://x/invite/t#k=e" });

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /create invite link/i }));

    await waitFor(() =>
      expect(createDriveInviteMock).toHaveBeenCalledWith(
        "team-docs",
        expect.objectContaining({ role: "writer" }),
      ),
    );
  });

  // The server caps a manager link at one use and 24 hours and answers 400
  // past either. Clamping in the form means the link the user gets is the link
  // the form described, instead of a rejection after they configured it.
  it("clamps a manager invite to the server's 24-hour cap", async () => {
    createDriveInviteMock.mockResolvedValue({ inviteUrl: "https://x/invite/t#k=e" });

    renderModal();
    chooseRole("Manager");
    fireEvent.click(screen.getByRole("button", { name: /create invite link/i }));

    await waitFor(() => expect(createDriveInviteMock).toHaveBeenCalled());
    const [, opts] = createDriveInviteMock.mock.calls[0];
    expect(opts.role).toBe("manager");
    expect(opts.expiresInSecs).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("names the role in the warning, so the link's power is stated", async () => {
    renderModal();
    chooseRole("Viewer");

    expect(screen.getByText(/join this drive as Viewer/i)).toBeInTheDocument();
    expect(screen.getByText(/Can open and download files/i)).toBeInTheDocument();
  });
});

// The dialog's own width, read off the source rather than measured — jsdom
// has no layout, so the classes are the only thing there is to assert.
describe("the invite dialog's frame", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../CreateDriveInviteDialog.tsx"),
    "utf8",
  );

  // A 585px card with a 405px column inside it is the recipe every
  // decision-shaped dialog in the app uses. FramedDialog's ring, border and
  // card padding cost ~104px a side on `sm+`, so both halves matter: a
  // narrower card crushes the column, and a column left to run the card's
  // full width strands two selects and two stacked buttons across 585px.
  it("uses the shared decision-dialog card and column widths", () => {
    expect(source).toContain('maxWidth="max-w-[585px]"');
    expect(source).toContain('contentClassName="sm:w-[405px]"');
  });

  it("matches the widths ConfirmationDialog defaults to", () => {
    const confirmation = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../ConfirmationDialog.tsx"),
      "utf8",
    );
    expect(confirmation).toContain('maxWidth = "max-w-[585px]"');
    expect(confirmation).toContain('contentClassName = "sm:w-[405px]"');
  });
});
