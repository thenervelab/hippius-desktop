// The Share dialog: two independent sections that must never reach each
// other's command. "Invite people" calls only the email command; "Share a
// link" calls only the link commands, and a folder target only ever the
// folder one. Every refusal is shown inline, beside the section it is about,
// never only as a toast.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import ShareDialog from "../ShareDialog";
import {
  driveInvitesVersionAtom,
  shareDialogAtom,
  type ShareDriveModalTarget,
} from "@/app/lib/global-atoms/sharesAtoms";
import { BILLING_ROUTE } from "@/app/lib/routes";

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
    listMyDriveMemberships: vi.fn().mockResolvedValue([]),
  };
});

const INVALID = "Enter one email address, like name@example.com.";
const WEEK = 7 * 24 * 60 * 60;

const notReady = (subkind: string, message = "x") => ({ kind: "NotReady", subkind, message });

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

  it("puts Invite people first, then Share a link, then one Done", () => {
    renderDialog();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Invite people", "Share a link"]);
    expect(screen.getAllByRole("button", { name: "Done" })).toHaveLength(1);
  });

  it("closes on Done", () => {
    const store = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(store.get(shareDialogAtom)).toBeNull();
  });

  it("opens straight into the upgrade prompt on a plan without sharing", () => {
    plan.included = false;
    renderDialog();
    expect(screen.getByText("Sharing needs a Plus, Max or Scale plan")).toBeInTheDocument();
    expect(screen.queryByText("Invite people")).not.toBeInTheDocument();
    expect(screen.queryByText("Share a link")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
  });

  it("shows both sections while the plan is still unknown", () => {
    plan.included = undefined;
    renderDialog();
    expect(screen.getByText("Invite people")).toBeInTheDocument();
    expect(screen.getByText("Share a link")).toBeInTheDocument();
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

  it("offers Viewer and Editor only, and says how to add a Manager", () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText("Invite role"));
    expect(screen.getAllByText("Editor").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Viewer").length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: "Manager" })).not.toBeInTheDocument();
    expect(
      screen.getByText("To add a Manager, invite them as an Editor, then change their role in Members."),
    ).toBeInTheDocument();
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
    const link = screen.getByRole("heading", { name: "Share a link" }).closest("section")!;
    expect(link).not.toHaveTextContent(text);
  });

  it("shows the plan prompt inline with its upgrade button (403)", async () => {
    emailDriveInviteMock.mockRejectedValue(notReady("SHARED_DRIVES_NOT_ENTITLED"));
    renderDialog();
    await typeEmail("ada@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByText("Sharing needs a Plus, Max or Scale plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade plan" }));
    expect(push).toHaveBeenCalledWith(BILLING_ROUTE);
  });
});

describe("Share a link", () => {
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
    expect(store.get(driveInvitesVersionAtom)).toBe(1);

    // Copy writes the FULL link and says so with a check.
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://console.example.com/invite/tok#k=abc"));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    // And another link is one click away.
    fireEvent.click(screen.getByRole("button", { name: "Create another link" }));
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  it("warns that anyone with a drive link can join", () => {
    renderDialog();
    expect(
      screen.getByText("Anyone with the link can join until it expires. Share it only with people you trust."),
    ).toBeInTheDocument();
  });

  it("offers Viewer, Editor and Manager for a drive, and keeps Manager's limits", () => {
    renderDialog();
    choose("Link access", "Manager");
    expect(screen.getByLabelText("Link expires")).toHaveTextContent("24 hours");
    expect(screen.getByText(/A manager link can only be used once and expires within 24 hours/)).toBeInTheDocument();
  });

  it("describes a manager link as single use, from what Rust sent", async () => {
    createDriveInviteMock.mockResolvedValue({
      inviteUrl: "https://x/invite/t#k=e",
      role: "manager",
      expiresInSecs: 24 * 60 * 60,
      maxUses: 1,
    });
    renderDialog();
    choose("Link access", "Manager");
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Manager · Expires in 24 hours · Single use")).toBeInTheDocument();
  });

  const LINK_CASES: Array<[string, unknown, string]> = [
    ["shared drives off on this server", notReady("SHARED_DRIVES_UNAVAILABLE"), "Shared drives aren't available on your server yet."],
    ["a server error Rust worded", { kind: "Hcfs", message: "server exploded" }, "server exploded"],
  ];

  it.each(LINK_CASES)("shows %s inline under the link choices", async (_name, err, text) => {
    createDriveInviteMock.mockRejectedValue(err);
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    const link = screen.getByRole("heading", { name: "Share a link" }).closest("section")!;
    await waitFor(() => expect(link).toHaveTextContent(text));
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the plan prompt inline with its upgrade button", async () => {
    createDriveInviteMock.mockRejectedValue(notReady("SHARED_DRIVES_NOT_ENTITLED"));
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Sharing needs a Plus, Max or Scale plan")).toBeInTheDocument();
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

  it("warns that a folder link works once, and offers nothing past 30 days", () => {
    renderDialog(folderTarget());
    expect(
      screen.getByText(
        "Works once, for the first person who opens it. Share it only with someone you trust with this folder.",
      ),
    ).toBeInTheDocument();
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
    // No Manager hint for a folder: Manager is not a folder role.
    expect(screen.queryByText(/To add a Manager/)).not.toBeInTheDocument();
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
    const link = screen.getByRole("heading", { name: "Share a link" }).closest("section")!;
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
