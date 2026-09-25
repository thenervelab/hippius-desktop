// The Share dialog: Invite people, People with access, General access, Done.
// "Invite people" calls only the email command; "General access" calls only
// the link commands, and a folder target only ever the folder one. People
// with access comes from one Rust fold and changes roles in place, putting a
// refused change back with the reason. Every refusal is shown inline, beside
// the section it is about, never only as a toast.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, configure, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import ShareDialog from "../ShareDialog";
import {
  driveInvitesVersionAtom,
  shareDialogAtom,
  shareDriveModalAtom,
  type ShareDriveModalTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import type { DriveInviteInfo, ShareAccess } from "@/app/lib/tauri/sharedDrives";
import { BILLING_ROUTE } from "@/app/lib/routes";

// The dialog mounts three sections and a Radix portal; under a loaded
// parallel run the default one second is not always enough to find a row.
configure({ asyncUtilTimeout: 3000 });

const flags = vi.hoisted(() => ({ sharedDrives: true, folderRoles: false }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SHARED_DRIVES_ENABLED() {
    return flags.sharedDrives;
  },
  get FOLDER_ROLES_ENABLED() {
    return flags.folderRoles;
  },
}));

const plan = vi.hoisted(() => ({ included: true as boolean | undefined }));
vi.mock("@/app/lib/hooks/useSharedDrivesInPlan", () => ({
  useSharedDrivesInPlan: () => plan.included,
}));

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const createDriveInviteMock = vi.fn();
const createFolderInviteMock = vi.fn();
const emailDriveInviteMock = vi.fn();
const emailInvitesAvailableMock = vi.fn();
const checkInviteEmailMock = vi.fn();
const listShareAccessMock = vi.fn();
const changeDriveMemberRoleMock = vi.fn();
const removeDriveMemberMock = vi.fn();
const revokeDriveInviteMock = vi.fn();
const approveEmailInviteMock = vi.fn();

// The wrappers are the dialog's only side effects; mocking them (not raw
// invoke) keeps these tests on the dialog's contract.
vi.mock("@/app/lib/tauri/sharedDrives", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/app/lib/tauri/sharedDrives")>();
  return {
    ...original,
    createDriveInvite: (...a: unknown[]) => createDriveInviteMock(...a),
    createFolderInvite: (...a: unknown[]) => createFolderInviteMock(...a),
    emailDriveInvite: (...a: unknown[]) => emailDriveInviteMock(...a),
    emailInvitesAvailable: (...a: unknown[]) => emailInvitesAvailableMock(...a),
    checkInviteEmail: (...a: unknown[]) => checkInviteEmailMock(...a),
    listShareAccess: (...a: unknown[]) => listShareAccessMock(...a),
    changeDriveMemberRole: (...a: unknown[]) => changeDriveMemberRoleMock(...a),
    removeDriveMember: (...a: unknown[]) => removeDriveMemberMock(...a),
    revokeDriveInvite: (...a: unknown[]) => revokeDriveInviteMock(...a),
    approveEmailInvite: (...a: unknown[]) => approveEmailInviteMock(...a),
    listMyDriveMemberships: vi.fn().mockResolvedValue([]),
  };
});

const INVALID = "Enter one email address, like name@example.com.";
const UPGRADE_TITLE = "Sharing is available on Plus, Max and Scale plans.";
const WEEK = 7 * 24 * 60 * 60;

const notReady = (subkind: string, message = "x") => ({ kind: "NotReady", subkind, message });

const ME = "5MeAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ANN = "5AnnBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function access(over: Partial<ShareAccess> = {}): ShareAccess {
  return {
    ownerSs58: ME,
    ownerIsYou: true,
    members: [],
    folderHolders: [],
    pendingInvites: [],
    driveMemberCount: 0,
    ...over,
  };
}

function mailed(id: string, email: string, status: DriveInviteInfo["emailStatus"]): DriveInviteInfo {
  return {
    inviteId: id,
    role: "reader",
    mintedBy: ME,
    expiresAt: new Date(Date.now() + 6.5 * 24 * 3600 * 1000).toISOString(),
    maxUses: 1,
    useCount: 0,
    revoked: false,
    valid: true,
    createdAt: "2026-09-20T00:00:00Z",
    recipientEmail: email,
    emailStatus: status,
  };
}

function renderDialog(target: ShareDriveModalTarget | null = { label: "team-docs", folderName: "team-docs" }) {
  const store = createStore();
  store.set(shareDialogAtom, target);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>{(<ShareDialog />) as ReactNode}</Provider>
    </QueryClientProvider>,
  );
  return store;
}

const folderTarget = (pathPrefix = "Clients/ACME"): ShareDriveModalTarget => ({
  label: "team-docs",
  folderName: "ACME",
  pathPrefix,
});

async function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value } });
  await waitFor(() => expect(checkInviteEmailMock).toHaveBeenCalledWith(value));
  // Let Rust's verdict land, so Send is enabled before anyone presses it.
  await act(async () => {});
}

/** Drive the custom Select: open by its aria-label, then click the option. */
function choose(selectLabel: string, option: string) {
  fireEvent.click(screen.getByLabelText(selectLabel));
  fireEvent.click(screen.getAllByText(option).at(-1)!);
}

function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  return writeText;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.sharedDrives = true;
  flags.folderRoles = false;
  plan.included = true;
  emailInvitesAvailableMock.mockResolvedValue(true);
  listShareAccessMock.mockResolvedValue(access());
  // Rust owns the rule; this stand-in only has to tell good from bad.
  checkInviteEmailMock.mockImplementation(async (email: string) => {
    const trimmed = email.trim();
    if (!trimmed) return { valid: false };
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? { valid: true } : { valid: false, message: INVALID };
  });
});

describe("the dialog", () => {
  it("renders nothing with the flag off", () => {
    flags.sharedDrives = false;
    renderDialog();
    expect(screen.queryByText(/Share “/)).not.toBeInTheDocument();
  });

  it("is titled with the drive, never a shared: wire label", () => {
    renderDialog();
    expect(screen.getByText("Share “team-docs”")).toBeInTheDocument();
  });

  it("says this drive for an unresolved shared: label", () => {
    const wire = "shared:5HHap2Pe2LaxxXp8Abcdefghijklmnop~263bad4ad83e395a";
    renderDialog({ label: wire, folderName: wire });
    expect(screen.getByText("Share “this drive”")).toBeInTheDocument();
    expect(screen.queryByText(/shared:5HHap/)).not.toBeInTheDocument();
  });

  it("is titled with the folder path for a folder", () => {
    renderDialog(folderTarget());
    expect(screen.getByText("Share “Clients/ACME”")).toBeInTheDocument();
  });

  it("puts Invite people, then People with access, then General access, then one Done", async () => {
    renderDialog();
    await screen.findByText("(1)");
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Invite people", "People with access (1)", "General access"]);
    expect(screen.getAllByRole("button", { name: "Done" })).toHaveLength(1);
    // No Copy link in the footer: copying belongs to a created link.
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  });

  it("says who has access under a drive's title", async () => {
    listShareAccessMock.mockResolvedValue(
      access({ members: [{ memberSs58: ANN, role: "writer", isYou: false }] }),
    );
    renderDialog();
    expect(await screen.findByText("Drive · 2 people have access")).toBeInTheDocument();
  });

  it("names the folder and its drive under a folder's title", () => {
    renderDialog(folderTarget());
    expect(screen.getByText("Clients/ACME in team-docs")).toBeInTheDocument();
  });

  it("closes on Done", () => {
    const store = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(store.get(shareDialogAtom)).toBeNull();
  });
});

// Sharing is on Plus, Max and Scale. Rust decides (`canShareDrives`); the
// dialog reads it through `useSharedDrivesInPlan`, mocked here as `plan`.
describe("a plan without sharing (Free, Starter)", () => {
  const withAnn = () =>
    access({
      members: [{ memberSs58: ANN, role: "writer", memberName: "Ann", memberEmail: "ann@example.com", isYou: false }],
    });

  it("puts the upgrade card where Invite people and General access were", async () => {
    plan.included = false;
    renderDialog();
    expect(screen.getByText(UPGRADE_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Invite people" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "General access" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invite" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
    // Not an error and not a toast: the card is the whole answer.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    expect(await screen.findByText("(1)")).toBeInTheDocument();
  });

  it("takes them to the Drive plans and closes the dialog", () => {
    plan.included = false;
    const store = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
    expect(store.get(shareDialogAtom)).toBeNull();
  });

  it("does the same for a folder", () => {
    plan.included = false;
    flags.folderRoles = true;
    renderDialog(folderTarget());
    expect(screen.getByText(UPGRADE_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  // Someone who downgraded still sees who has access and can take it away.
  it("still lists people and removes them", async () => {
    plan.included = false;
    listShareAccessMock.mockResolvedValue(withAnn());
    removeDriveMemberMock.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText("Ann");
    choose("Role for Ann", "Remove access");
    listShareAccessMock.mockResolvedValue(access());
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeDriveMemberMock).toHaveBeenCalledWith("team-docs", ANN, undefined));
    await waitFor(() => expect(screen.queryByText("Ann")).not.toBeInTheDocument());
  });

  // Approving a waiting invitation adds someone; cancelling it does not.
  it("offers Cancel on a waiting invitation but not Approve", async () => {
    plan.included = false;
    listShareAccessMock.mockResolvedValue(
      access({ pendingInvites: [mailed("i2", "opened@example.com", "awaiting_seal")] }),
    );
    revokeDriveInviteMock.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText("opened@example.com");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel invite to opened@example.com" }));
    await waitFor(() => expect(revokeDriveInviteMock).toHaveBeenCalledWith("team-docs", "i2", undefined));
  });
});

describe("while the plan is loading", () => {
  it("shows skeletons where the add-people controls go, and no upgrade card", () => {
    plan.included = undefined;
    renderDialog();
    expect(screen.getAllByRole("status", { name: "Loading sharing options" })).toHaveLength(2);
    expect(screen.queryByText(UPGRADE_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
    // The people list does not wait on the plan.
    expect(listShareAccessMock).toHaveBeenCalled();
  });

  it("swaps the skeletons for the controls once the plan allows sharing", async () => {
    plan.included = undefined;
    const store = renderDialog();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    plan.included = true;
    // The same target again re-renders the dialog, which reads the answer.
    act(() => store.set(shareDialogAtom, { label: "team-docs", folderName: "team-docs" }));
    expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading sharing options" })).not.toBeInTheDocument();
  });
});

describe("Invite people", () => {
  it("sends through the email command only, and stays open for the next person", async () => {
    emailDriveInviteMock.mockResolvedValue({ inviteId: "i1" });
    const store = renderDialog();
    await typeEmail("ada@example.com");
    choose("Invite role", "Viewer");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(emailDriveInviteMock).toHaveBeenCalledWith("team-docs", "ada@example.com", {
        role: "reader",
        target: undefined,
      }),
    );
    expect(await screen.findByText("Invite sent to ada@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(createDriveInviteMock).not.toHaveBeenCalled();
    expect(createFolderInviteMock).not.toHaveBeenCalled();
    // Still open, and the Links tab is told to reload.
    expect(store.get(shareDialogAtom)).not.toBeNull();
    expect(store.get(driveInvitesVersionAtom)).toBe(1);
  });

  it("sends as Editor by default for a drive, and leaves the expiry to Rust", async () => {
    emailDriveInviteMock.mockResolvedValue({ inviteId: "i1" });
    renderDialog();
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(emailDriveInviteMock).toHaveBeenCalled());
    const [, , opts] = emailDriveInviteMock.mock.calls[0];
    expect(opts.role).toBe("writer");
    expect(opts).not.toHaveProperty("expiresInSecs");
  });

  it("is one field at rest; the role, Send and help appear once there is text", async () => {
    renderDialog();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.queryByLabelText("Invite role")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invite" })).not.toBeInTheDocument();
    expect(screen.queryByText("They get their own invite that only works for them.")).not.toBeInTheDocument();
    await typeEmail("a");
    expect(screen.getByLabelText("Invite role")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send invite" })).toBeInTheDocument();
    expect(screen.getByText("They get their own invite that only works for them.")).toBeInTheDocument();
    await typeEmail("");
    expect(screen.queryByLabelText("Invite role")).not.toBeInTheDocument();
  });

  it("offers Viewer and Editor only, and never mentions Managers", async () => {
    renderDialog();
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByLabelText("Invite role"));
    expect(screen.getAllByText("Editor").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Viewer").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Manager/)).not.toBeInTheDocument();
    expect(screen.getByText("They get their own invite that only works for them.")).toBeInTheDocument();
  });

  it("checks the address with Rust and says what is wrong once the field is left", async () => {
    renderDialog();
    await typeEmail("ada");
    const send = screen.getByRole("button", { name: "Send invite" });
    expect(send).toBeDisabled();
    // Not while typing.
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
    fireEvent.blur(screen.getByLabelText("Email address"));
    expect(screen.getByText(INVALID)).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveAttribute("aria-invalid", "true");

    await typeEmail("ada@example.com");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send invite" })).toBeEnabled());
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
  });

  it("never sends an address Rust refused, even on Enter", async () => {
    renderDialog();
    await typeEmail("ada");
    fireEvent.submit(screen.getByLabelText("Email address").closest("form")!);
    await waitFor(() => expect(screen.getByText(INVALID)).toBeInTheDocument());
    expect(emailDriveInviteMock).not.toHaveBeenCalled();
  });

  it("says email is coming soon, before typing, when the probe knows", async () => {
    emailInvitesAvailableMock.mockResolvedValue(false);
    renderDialog();
    expect(
      await screen.findByText("Email invites are coming soon. For now, copy the invite link and send it yourself."),
    ).toBeInTheDocument();
    await typeEmail("ada@example.com");
    expect(screen.getByRole("button", { name: "Send invite" })).toBeDisabled();
  });

  const EMAIL_CASES: Array<[string, unknown, string]> = [
    [
      "no mail service (503)",
      notReady("EMAIL_INVITES_UNAVAILABLE"),
      "Email invites are coming soon. For now, copy the invite link and send it yourself.",
    ],
    [
      "rate limited (429), with the wait",
      notReady("RATE_LIMITED", "Too many invitations sent recently. Try again in 3 minutes."),
      "Too many invitations sent recently. Try again in 3 minutes.",
    ],
    [
      "the send failed (502)",
      { kind: "Validation", message: "The invitation email could not be sent, so the invite was cancelled. Try again." },
      "The invitation email could not be sent, so the invite was cancelled. Try again.",
    ],
    [
      "shared drives off on this server",
      notReady("SHARED_DRIVES_UNAVAILABLE"),
      "Shared drives aren't available on your server yet.",
    ],
  ];

  it.each(EMAIL_CASES)("shows %s inline, never only as a toast", async (_name, err, text) => {
    emailDriveInviteMock.mockRejectedValue(err);
    renderDialog();
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    const invite = screen.getByRole("heading", { name: "Invite people" }).closest("section")!;
    await waitFor(() => expect(invite).toHaveTextContent(text));
    // The address stays, so trying again is one click.
    expect(screen.getByLabelText("Email address")).toHaveValue("ada@example.com");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    // The link section is untouched.
    const link = screen.getByRole("heading", { name: "General access" }).closest("section")!;
    expect(link).not.toHaveTextContent(text);
  });

  // The server is the authority: a plan the app thought could share still
  // ends on the same upgrade card, never a raw error.
  it("turns a 403 not-entitled into the upgrade card, keeping the people", async () => {
    emailDriveInviteMock.mockRejectedValue(notReady("SHARED_DRIVES_NOT_ENTITLED"));
    renderDialog();
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByText(UPGRADE_TITLE)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /People with access/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
  });
});

describe("General access", () => {
  it("creates through the drive link command only and shows the link with its key hidden", async () => {
    const writeText = installClipboard();
    createDriveInviteMock.mockResolvedValue({
      inviteUrl: "https://console.example.com/invite/tok#k=abc",
      role: "writer",
      expiresInSecs: WEEK,
      maxUses: 50,
    });
    const store = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() =>
      expect(createDriveInviteMock).toHaveBeenCalledWith("team-docs", {
        expiresInSecs: WEEK,
        role: "writer",
        target: undefined,
      }),
    );
    expect(emailDriveInviteMock).not.toHaveBeenCalled();
    expect(createFolderInviteMock).not.toHaveBeenCalled();
    expect(await screen.findByText("https://console.example.com/invite/tok…")).toBeInTheDocument();
    expect(screen.queryByText(/#k=/)).not.toBeInTheDocument();
    expect(screen.getByText("Editor · Expires in 7 days · Up to 50 uses")).toBeInTheDocument();
    expect(screen.getByText("Anyone with the link")).toBeInTheDocument();
    expect(store.get(driveInvitesVersionAtom)).toBe(1);

    // Copy writes the FULL link and says so with a check.
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://console.example.com/invite/tok#k=abc"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    // And another link is one click away.
    fireEvent.click(screen.getByRole("button", { name: "Create another link" }));
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  it("keeps access, expiry and Create link on one non-wrapping row at dialog width", () => {
    renderDialog();
    const row = screen.getByTestId("general-access-controls");
    const access = screen.getByLabelText("Link access");
    const expires = screen.getByLabelText("Link expires");
    const create = screen.getByRole("button", { name: "Create link" });
    for (const control of [access, expires, create]) expect(row).toContainElement(control);

    // The row is keyed to the dialog column (a container query), never wraps,
    // and the selects' own group dissolves into it at that width.
    const rowClasses = row.className.split(/\s+/);
    expect(rowClasses).toEqual(expect.arrayContaining(["@md:flex-row", "@md:flex-nowrap"]));
    expect(row.className).not.toMatch(/(^|\s)(\S+:)?flex-wrap(\s|$)/);
    expect(row.parentElement?.closest(".\\@container")).not.toBeNull();
    // Each select sits in a field (label over select) inside the selects'
    // group, which dissolves into the row at that width.
    const accessField = access.parentElement?.parentElement;
    const expiresField = expires.parentElement?.parentElement;
    expect(accessField?.parentElement?.className).toContain("@md:contents");
    expect(expiresField?.parentElement).toBe(accessField?.parentElement);

    // Bottom-aligned, so the button lines up with the selects, not the labels.
    expect(rowClasses).toContain("@md:items-end");

    // A compact fixed width for Access; the expiry select grows into the
    // rest of the row so there is no empty gap before the button, which
    // keeps its natural width, flush right.
    expect(accessField?.className).toContain("@md:w-[120px]");
    expect(accessField?.className).toContain("@md:flex-none");
    expect(expiresField?.className.split(/\s+/)).toEqual(expect.arrayContaining(["@md:flex-1", "min-w-0"]));
    expect(expiresField?.className).not.toContain("@md:flex-none");
    expect(create.className).toContain("@md:ml-auto");
    expect(create.className).toContain("@md:w-auto");
    expect(create.className).toContain("h-[34px]");
  });

  it("labels the access and expiry selects and ties each label to its select", () => {
    renderDialog();
    const row = screen.getByTestId("general-access-controls");
    const access = screen.getByLabelText("Link access");
    const expires = screen.getByLabelText("Link expires");

    const accessLabel = screen.getByText("Access", { selector: "label" });
    const expiresLabel = screen.getByText("Link expires", { selector: "label" });
    expect(access.id).not.toBe("");
    expect(expires.id).not.toBe("");
    expect(accessLabel).toHaveAttribute("for", access.id);
    expect(expiresLabel).toHaveAttribute("for", expires.id);
    expect(screen.getByLabelText("Access", { selector: "button" })).toBe(access);

    // The labels travel with their selects, inside the one row container.
    expect(accessLabel.parentElement).toContainElement(access);
    expect(expiresLabel.parentElement).toContainElement(expires);
    for (const el of [accessLabel, expiresLabel, access, expires, screen.getByRole("button", { name: "Create link" })]) {
      expect(row).toContainElement(el);
    }
  });

  it("says anyone with a drive link can join", () => {
    renderDialog();
    expect(screen.getByText("Invite link")).toBeInTheDocument();
    expect(screen.getByText("Anyone with the link can join until it expires.")).toBeInTheDocument();
  });

  it("revokes the link it just made, by the id Rust returned", async () => {
    installClipboard();
    createDriveInviteMock.mockResolvedValue({
      inviteUrl: "https://x/invite/t#k=e",
      inviteId: "inv-1",
      role: "writer",
      expiresInSecs: WEEK,
      maxUses: 50,
    });
    revokeDriveInviteMock.mockResolvedValue(undefined);
    const store = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeDriveInviteMock).toHaveBeenCalledWith("team-docs", "inv-1", undefined));
    expect(await screen.findByText("That link was revoked and no longer works.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
    expect(store.get(driveInvitesVersionAtom)).toBe(2);
  });

  it("offers Viewer and Editor only for a drive link, with every lifetime", () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText("Link access"));
    expect(screen.getAllByText("Viewer").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Manager/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Viewer").at(-1)!);
    // Picking a role never narrows the lifetime: no role is capped any more.
    choose("Link expires", "Never expires");
    expect(screen.getByLabelText("Link expires")).toHaveTextContent("Never expires");
    expect(screen.queryByText(/Works once and expires within 24 hours/)).not.toBeInTheDocument();
  });

  const LINK_CASES: Array<[string, unknown, string]> = [
    ["shared drives off on this server", notReady("SHARED_DRIVES_UNAVAILABLE"), "Shared drives aren't available on your server yet."],
    ["a server error Rust worded", { kind: "Hcfs", message: "server exploded" }, "server exploded"],
  ];

  it.each(LINK_CASES)("shows %s inline under the link choices", async (_name, err, text) => {
    createDriveInviteMock.mockRejectedValue(err);
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    const link = screen.getByRole("heading", { name: "General access" }).closest("section")!;
    await waitFor(() => expect(link).toHaveTextContent(text));
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("turns a 403 not-entitled into the upgrade card", async () => {
    createDriveInviteMock.mockRejectedValue(notReady("SHARED_DRIVES_NOT_ENTITLED"));
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText(UPGRADE_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
  });
});

describe("a folder target", () => {
  it("without folder roles: link only, view only, through the folder command only", async () => {
    createFolderInviteMock.mockResolvedValue({
      inviteUrl: "https://x/invite/t#k=e",
      role: "reader",
      expiresInSecs: WEEK,
      maxUses: 1,
    });
    renderDialog(folderTarget());
    // No email section, and no mail probe for it.
    expect(screen.queryByText("Invite people")).not.toBeInTheDocument();
    expect(emailInvitesAvailableMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Link access"));
    expect(screen.queryByRole("option", { name: "Editor" })).not.toBeInTheDocument();
    // Picking the only option closes the list again.
    fireEvent.click(screen.getAllByText("Viewer").at(-1)!);

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(createFolderInviteMock).toHaveBeenCalledWith("team-docs", "Clients/ACME", {
        expiresInSecs: WEEK,
        role: "reader",
        target: undefined,
      }),
    );
    expect(createDriveInviteMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Viewer · Expires in 7 days · Single use")).toBeInTheDocument();
  });

  // The folder path's PRESENCE makes it a folder. An empty one still goes to
  // the folder command, which refuses it, and never becomes a drive invite.
  it("never falls back to a whole-drive link, even with an empty folder path", async () => {
    createFolderInviteMock.mockRejectedValue({ kind: "Validation", message: "A folder invite needs a folder path." });
    renderDialog(folderTarget(""));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(createFolderInviteMock).toHaveBeenCalledWith("team-docs", "", expect.anything()));
    expect(createDriveInviteMock).not.toHaveBeenCalled();
    expect(await screen.findByText("A folder invite needs a folder path.")).toBeInTheDocument();
  });

  it("says a folder link works once, and offers nothing past 30 days", () => {
    renderDialog(folderTarget());
    expect(screen.getByText("Invite link for one person")).toBeInTheDocument();
    expect(screen.getByText("Works once, for the first person who opens it.")).toBeInTheDocument();
    expect(screen.getByLabelText("Link expires")).toHaveTextContent("7 days");
    fireEvent.click(screen.getByLabelText("Link expires"));
    expect(screen.queryByText("Never expires")).not.toBeInTheDocument();
  });

  it("with folder roles: mints Editor through the folder command", async () => {
    flags.folderRoles = true;
    createFolderInviteMock.mockResolvedValue({
      inviteUrl: "https://x/invite/t#k=e",
      role: "writer",
      expiresInSecs: WEEK,
      maxUses: 1,
    });
    renderDialog(folderTarget());
    choose("Link access", "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(createFolderInviteMock).toHaveBeenCalledWith(
        "team-docs",
        "Clients/ACME",
        expect.objectContaining({ role: "writer" }),
      ),
    );
    expect(createDriveInviteMock).not.toHaveBeenCalled();
  });

  it("with folder roles: emails through the email command with the folder", async () => {
    flags.folderRoles = true;
    emailDriveInviteMock.mockResolvedValue({ inviteId: "i1" });
    renderDialog(folderTarget());
    expect(screen.queryByText(/Manager/)).not.toBeInTheDocument();
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() =>
      expect(emailDriveInviteMock).toHaveBeenCalledWith("team-docs", "ada@example.com", {
        role: "reader",
        target: undefined,
        pathPrefix: "Clients/ACME",
      }),
    );
    expect(createFolderInviteMock).not.toHaveBeenCalled();
    expect(createDriveInviteMock).not.toHaveBeenCalled();
  });

  it("says folder sharing is coming soon, inline in the section that asked", async () => {
    flags.folderRoles = true;
    createFolderInviteMock.mockRejectedValue(notReady("FOLDER_INVITES_UNAVAILABLE"));
    emailDriveInviteMock.mockRejectedValue(notReady("FOLDER_INVITES_UNAVAILABLE"));
    renderDialog(folderTarget());
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    const link = screen.getByRole("heading", { name: "General access" }).closest("section")!;
    await waitFor(() => expect(link).toHaveTextContent("Sharing a single folder is coming soon."));

    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    const invite = screen.getByRole("heading", { name: "Invite people" }).closest("section")!;
    await waitFor(() => expect(invite).toHaveTextContent("Sharing a single folder is coming soon."));
  });

  it("says folder email is coming soon", async () => {
    flags.folderRoles = true;
    emailDriveInviteMock.mockRejectedValue(notReady("FOLDER_EMAIL_INVITES_UNAVAILABLE"));
    renderDialog(folderTarget());
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(
      await screen.findByText(
        "Email invites for a single folder are coming soon. For now, copy the invite link and send it yourself.",
      ),
    ).toBeInTheDocument();
  });

  it("offers to send as view only when Editor on a folder is coming soon", async () => {
    flags.folderRoles = true;
    emailDriveInviteMock
      .mockRejectedValueOnce(notReady("FOLDER_EDITOR_INVITES_UNAVAILABLE"))
      .mockResolvedValueOnce({ inviteId: "i2" });
    renderDialog(folderTarget());
    await typeEmail("ada@example.com");
    choose("Invite role", "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(
      await screen.findByText("Editor access for a single folder is coming soon. You can share it as view only for now."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send as view only" }));
    await waitFor(() => expect(emailDriveInviteMock).toHaveBeenCalledTimes(2));
    expect(emailDriveInviteMock.mock.calls[0][2]).toMatchObject({ role: "writer" });
    expect(emailDriveInviteMock.mock.calls[1][2]).toMatchObject({ role: "reader", pathPrefix: "Clients/ACME" });
    expect(await screen.findByText("Invite sent to ada@example.com")).toBeInTheDocument();
  });

  it("offers to create a view-only link when Editor on a folder is coming soon", async () => {
    flags.folderRoles = true;
    createFolderInviteMock
      .mockRejectedValueOnce(notReady("FOLDER_EDITOR_INVITES_UNAVAILABLE"))
      .mockResolvedValueOnce({ inviteUrl: "https://x/invite/t#k=e", role: "reader", expiresInSecs: WEEK, maxUses: 1 });
    renderDialog(folderTarget());
    choose("Link access", "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByText(/Editor access for a single folder is coming soon/);
    fireEvent.click(screen.getByRole("button", { name: "Create as view only" }));
    await waitFor(() => expect(createFolderInviteMock).toHaveBeenCalledTimes(2));
    expect(createFolderInviteMock.mock.calls[1][2]).toMatchObject({ role: "reader" });
    expect(createDriveInviteMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Viewer · Expires in 7 days · Single use")).toBeInTheDocument();
  });
});

describe("People with access", () => {
  const withAnn = () =>
    access({
      members: [{ memberSs58: ANN, role: "writer", memberName: "Ann", memberEmail: "ann@example.com", isYou: false }],
    });

  function peopleSection() {
    return screen.getByRole("heading", { name: /People with access/ }).closest("section")!;
  }

  it("shows skeleton rows while the list loads, then the owner as you", async () => {
    let resolve: (a: ShareAccess) => void = () => {};
    listShareAccessMock.mockReturnValue(new Promise<ShareAccess>((r) => (resolve = r)));
    renderDialog();
    expect(screen.getByRole("status", { name: "Loading people with access" })).toBeInTheDocument();
    resolve(access());
    expect(await screen.findByText("(you)")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading people with access" })).not.toBeInTheDocument();
    expect(listShareAccessMock).toHaveBeenCalledWith("team-docs", null, undefined);
  });

  it("asks Rust about exactly the folder for a folder dialog", async () => {
    renderDialog(folderTarget());
    await waitFor(() => expect(listShareAccessMock).toHaveBeenCalledWith("team-docs", "Clients/ACME", undefined));
  });

  const annAsViewer = () =>
    access({ members: [{ memberSs58: ANN, role: "reader", memberName: "Ann", isYou: false }] });

  it("offers Viewer and Editor only in a member's role picker", async () => {
    listShareAccessMock.mockResolvedValue(withAnn());
    renderDialog();
    await screen.findByText("Ann");
    fireEvent.click(screen.getByLabelText("Role for Ann"));
    expect(screen.getAllByText("Viewer").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Remove access").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Manager/)).not.toBeInTheDocument();
  });

  it("changes a role only once Rust has, saying Saving meanwhile", async () => {
    listShareAccessMock.mockResolvedValueOnce(annAsViewer());
    let finish: () => void = () => {};
    changeDriveMemberRoleMock.mockReturnValue(new Promise<void>((r) => (finish = r)));
    const store = renderDialog();
    await screen.findByText("Ann");
    choose("Role for Ann", "Editor");
    await waitFor(() => expect(changeDriveMemberRoleMock).toHaveBeenCalledWith("team-docs", ANN, "writer", undefined));
    // Not shown as done while the server has not answered.
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.getByLabelText("Role for Ann")).toHaveTextContent("Viewer");
    expect(screen.getByLabelText("Role for Ann")).toBeDisabled();

    listShareAccessMock.mockResolvedValue(withAnn());
    finish();
    await waitFor(() => expect(screen.getByLabelText("Role for Ann")).toHaveTextContent("Editor"));
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
    expect(store.get(driveInvitesVersionAtom)).toBe(1);
  });

  it("leaves a refused role change as it was and says why, inline", async () => {
    listShareAccessMock.mockResolvedValue(annAsViewer());
    changeDriveMemberRoleMock.mockRejectedValue({ kind: "Validation", message: "The server refused the change." });
    renderDialog();
    await screen.findByText("Ann");
    choose("Role for Ann", "Editor");
    expect(
      await within(peopleSection()).findByText("Couldn't change access for Ann. The server refused the change."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Role for Ann")).toHaveTextContent("Viewer");
    expect(screen.getByLabelText("Role for Ann")).toBeEnabled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("asks before a demotion, since it revokes links too", async () => {
    listShareAccessMock.mockResolvedValue(withAnn());
    changeDriveMemberRoleMock.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText("Ann");
    choose("Role for Ann", "Viewer");
    expect(await screen.findByText("Make Ann a Viewer?")).toBeInTheDocument();
    expect(changeDriveMemberRoleMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change role" }));
    await waitFor(() => expect(changeDriveMemberRoleMock).toHaveBeenCalledWith("team-docs", ANN, "reader", undefined));
  });

  it("removes a member only after confirming", async () => {
    listShareAccessMock.mockResolvedValue(withAnn());
    removeDriveMemberMock.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText("Ann");
    choose("Role for Ann", "Remove access");
    expect(removeDriveMemberMock).not.toHaveBeenCalled();
    listShareAccessMock.mockResolvedValue(access());
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeDriveMemberMock).toHaveBeenCalledWith("team-docs", ANN, undefined));
    await waitFor(() => expect(screen.queryByText("Ann")).not.toBeInTheDocument());
  });

  it("says Removing while a removal is on the wire, and keeps the row until it is done", async () => {
    listShareAccessMock.mockResolvedValue(withAnn());
    removeDriveMemberMock.mockReturnValue(new Promise(() => {}));
    renderDialog();
    await screen.findByText("Ann");
    choose("Role for Ann", "Remove access");
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removing…")).toBeInTheDocument();
    expect(screen.getByText("Ann")).toBeInTheDocument();
  });

  it("never offers a role change on your own row", async () => {
    listShareAccessMock.mockResolvedValue(
      access({ ownerSs58: ANN, ownerIsYou: false, members: [{ memberSs58: ME, role: "writer", isYou: true }] }),
    );
    renderDialog({ label: "team-docs", folderName: "team-docs", ownerSs58: ANN, folderHash: "abc" });
    await screen.findByText("(you)");
    expect(screen.queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(peopleSection()).getByText("Editor")).toBeInTheDocument();
  });

  // Only the owner changes access. On somebody else's drive nobody's row is
  // editable, a former Manager's view included.
  it("shows everyone read only on a drive you do not own", async () => {
    listShareAccessMock.mockResolvedValue(
      access({
        ownerSs58: ANN,
        ownerIsYou: false,
        members: [
          { memberSs58: ME, role: "writer", isYou: true },
          { memberSs58: "5Other", memberName: "Other", role: "reader", isYou: false },
        ],
      }),
    );
    renderDialog({ label: "team-docs", folderName: "team-docs", ownerSs58: ANN, folderHash: "abc" });
    await screen.findByText("Other");
    expect(screen.queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(peopleSection()).getByText("Viewer")).toBeInTheDocument();
  });

  it("lists folder holders with their role as text, Remove, and how to change access", async () => {
    listShareAccessMock.mockResolvedValue(
      access({
        folderHolders: [
          { memberSs58: ANN, role: "writer", pathPrefix: "Clients/ACME", memberName: "Ann", otherFolderCount: 1 },
        ],
      }),
    );
    removeDriveMemberMock.mockResolvedValue(undefined);
    renderDialog(folderTarget());
    await screen.findByText("Ann");
    expect(within(peopleSection()).getByText("Editor")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Ann")).not.toBeInTheDocument();
    expect(
      screen.getByText("To change someone’s access to this folder, remove them and invite them again."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ann" }));
    expect(await screen.findByText(/also removes their access to 1 other folder/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeDriveMemberMock).toHaveBeenCalledWith("team-docs", ANN, undefined));
  });

  it("shows pending emailed invites, with Approve only on the one that needs it", async () => {
    listShareAccessMock.mockResolvedValue(
      access({
        pendingInvites: [mailed("i1", "sent@example.com", "sent"), mailed("i2", "opened@example.com", "awaiting_seal")],
      }),
    );
    approveEmailInviteMock.mockResolvedValue({ status: "sealed" });
    revokeDriveInviteMock.mockResolvedValue(undefined);
    renderDialog();
    await screen.findByText("sent@example.com");
    expect(screen.getByText("Invite sent · expires in 7 days")).toBeInTheDocument();
    expect(screen.getByText("Needs your approval · expires in 7 days")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approveEmailInviteMock).toHaveBeenCalledWith("team-docs", "i2", undefined));

    fireEvent.click(screen.getByRole("button", { name: "Cancel invite to sent@example.com" }));
    await waitFor(() => expect(revokeDriveInviteMock).toHaveBeenCalledWith("team-docs", "i1", undefined));
  });

  it("keeps a pending invite when cancelling it fails", async () => {
    listShareAccessMock.mockResolvedValue(access({ pendingInvites: [mailed("i1", "sent@example.com", "sent")] }));
    revokeDriveInviteMock.mockRejectedValue({ kind: "Hcfs", message: "server exploded" });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel invite to sent@example.com" }));
    expect(await screen.findByText("Couldn't change access for sent@example.com. server exploded")).toBeInTheDocument();
    expect(screen.getByText("sent@example.com")).toBeInTheDocument();
  });

  it("cuts a long name short beside a role slot of fixed width", async () => {
    const long = "Srinivasa Ramanujan Aiyangar Venkataraghavan";
    listShareAccessMock.mockResolvedValue(
      access({ members: [{ memberSs58: "5Long", memberName: long, memberEmail: "sr@example.com", role: "writer", isYou: false }] }),
    );
    renderDialog();
    const name = await screen.findByText(long);
    expect(name).toHaveClass("truncate");
    expect(name.closest(".flex-1")).toHaveClass("min-w-0", "overflow-hidden");
    expect(screen.getByText("sr@example.com")).toHaveClass("truncate");
    expect(screen.getByLabelText(`Role for ${long}`).closest("span.shrink-0")).toHaveClass("w-[98px]");
  });

  it("shows six rows at most, the last one leading to Manage access", async () => {
    listShareAccessMock.mockResolvedValue(
      access({
        members: Array.from({ length: 6 }, (_, i) => ({
          memberSs58: `5M${i}`,
          memberName: `Person ${i}`,
          role: "reader",
          isYou: false,
        })),
      }),
    );
    const store = renderDialog();
    await screen.findByText("Person 0");
    // Owner + 4 people + the "more" row = 6 rows.
    expect(screen.getByText("Person 3")).toBeInTheDocument();
    expect(screen.queryByText("Person 4")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+2 more · Manage access" }));
    // Straight to the full list of people: they are what the row stood for.
    expect(store.get(shareDriveModalAtom)).toMatchObject({ label: "team-docs", openOn: "people" });
    expect(store.get(shareDialogAtom)).toBeNull();
  });

  it("lists you right after the owner", async () => {
    listShareAccessMock.mockResolvedValue(
      access({
        ownerSs58: ANN,
        ownerIsYou: false,
        members: [
          { memberSs58: "5Other", memberName: "Other", role: "reader", isYou: false },
          { memberSs58: ME, memberName: "Me", role: "writer", isYou: true },
        ],
      }),
    );
    renderDialog();
    await screen.findByText("Me");
    const rows = within(peopleSection()).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(rows[1]).toContain("Me");
    expect(rows[2]).toContain("Other");
  });

  it("lists a new invitation as pending once it is sent", async () => {
    emailDriveInviteMock.mockResolvedValue({ inviteId: "i9" });
    renderDialog();
    await screen.findByText("(you)");
    listShareAccessMock.mockResolvedValue(access({ pendingInvites: [mailed("i9", "ada@example.com", "sent")] }));
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await within(peopleSection()).findByText("ada@example.com")).toBeInTheDocument();
  });

  it("opens the manage panel for the same folder and closes the dialog", async () => {
    const store = renderDialog(folderTarget());
    fireEvent.click(screen.getByRole("button", { name: "Manage access" }));
    expect(store.get(shareDialogAtom)).toBeNull();
    expect(store.get(shareDriveModalAtom)).toEqual({
      label: "team-docs",
      folderName: "team-docs",
      ownerSs58: undefined,
      folderHash: undefined,
      pathPrefix: "Clients/ACME",
    });
  });

  it("opens the drive's panel from a drive dialog, with no folder", async () => {
    const store = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Manage access" }));
    const opened = store.get(shareDriveModalAtom);
    expect(opened).toMatchObject({ label: "team-docs" });
    expect(opened && "pathPrefix" in opened).toBe(false);
  });

  it("says a server without shared drives is not ready, and never shows a toast", async () => {
    listShareAccessMock.mockRejectedValue(notReady("SHARED_DRIVES_UNAVAILABLE"));
    renderDialog();
    expect(await within(peopleSection()).findByText("Shared drives aren't available on your server yet.")).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
