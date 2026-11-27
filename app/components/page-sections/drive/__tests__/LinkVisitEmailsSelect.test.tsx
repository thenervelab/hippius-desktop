import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";

import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";
import {
  FIRST_VIEW_EMAIL,
  FirstViewEmailSwitch,
  LINK_VISIT_EMAILS,
  LinkVisitEmailsSelect,
  VISIT_EMAILS_NEED_FIRST_VIEWS,
  VISIT_EMAILS_NEED_INSIGHTS,
} from "../SecureLinkSection";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Answers `share_can_receive_link_emails` and the link's setting; anything else from `invokeMock`. */
const answers = vi.hoisted(() => ({
  canReceive: true as boolean,
  visits: "first" as string | null,
  firstViews: true as boolean,
}));

function wire() {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "share_can_receive_link_emails") return Promise.resolve(answers.canReceive);
    if (cmd === "share_get_link_visit_emails") return Promise.resolve(answers.visits);
    if (cmd === "share_set_link_visit_emails") return Promise.resolve(undefined);
    if (cmd === "share_get_notification_preferences")
      return Promise.resolve({ firstViews: answers.firstViews, comments: true, digest: "weekly" });
    if (cmd === "share_set_notification_preferences") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

function setCaps(caps: Partial<ServerCapabilities> | null) {
  act(() => getDefaultStore().set(serverCapabilitiesAtom, caps as ServerCapabilities | null));
}

const commands = () => invokeMock.mock.calls.map(([cmd]) => cmd);

describe("LinkVisitEmailsSelect", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.error).mockReset();
    answers.canReceive = true;
    answers.visits = "first";
    answers.firstViews = true;
    wire();
    setCaps({ shares: true, share_notifications: true, share_link_notifications: true });
  });

  it("shows nothing and asks nothing while the server has no per-link setting", async () => {
    setCaps({ shares: true, share_notifications: true });
    const { container } = render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("stays on a link that does not count views, keeping only None, with the reason under the others", async () => {
    answers.visits = "every";
    render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted={false} layout="list" />);

    // What the link has stays shown, even a choice that does nothing now.
    const select = await screen.findByLabelText(LINK_VISIT_EMAILS);
    expect(select).toHaveTextContent("Every visit");
    fireEvent.click(select);
    for (const name of [/^Every visit/, /^First visit/]) {
      const option = await screen.findByRole("option", { name });
      expect(option).toHaveAttribute("data-disabled");
      expect(option).toHaveTextContent(VISIT_EMAILS_NEED_INSIGHTS);
      expect(option).toHaveAttribute("title", VISIT_EMAILS_NEED_INSIGHTS);
    }
    // None also silences the link's NDA and refused viewer emails, so it stays.
    const none = screen.getByRole("option", { name: "None" });
    expect(none).not.toHaveAttribute("data-disabled");
    fireEvent.click(none);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_link_visit_emails", { shareToken: "tok", visits: "off" }),
    );
    expect(screen.getByLabelText(LINK_VISIT_EMAILS)).toHaveTextContent("None");
  });

  it("says why views come first when the link counts none and First views is off too", async () => {
    render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted={false} firstViews={false} />);
    fireEvent.click(await screen.findByLabelText(LINK_VISIT_EMAILS));
    const every = await screen.findByRole("option", { name: /^Every visit/ });
    expect(every).toHaveAttribute("title", VISIT_EMAILS_NEED_INSIGHTS);
  });

  it("still shows nothing on a link that counts no views where the server has no per-link setting", async () => {
    setCaps({ shares: true, share_notifications: true });
    const { container } = render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted={false} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows nothing for an account that cannot get email", async () => {
    answers.canReceive = false;
    const { container } = render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted />);
    await waitFor(() => expect(commands()).toContain("share_can_receive_link_emails"));
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(commands()).not.toContain("share_get_link_visit_emails");
  });

  it("shows nothing when Rust has no value for the link", async () => {
    answers.visits = null;
    const { container } = render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted />);
    await waitFor(() => expect(commands()).toContain("share_get_link_visit_emails"));
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the link's setting and saves a change for that link", async () => {
    render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted />);

    const select = await screen.findByLabelText(LINK_VISIT_EMAILS);
    expect(select).toHaveTextContent("First visit");
    expect(invokeMock).toHaveBeenCalledWith("share_get_link_visit_emails", { shareToken: "tok" });

    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Every visit" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_link_visit_emails", { shareToken: "tok", visits: "every" }),
    );
    expect(screen.getByLabelText(LINK_VISIT_EMAILS)).toHaveTextContent("Every visit");
  });

  it("puts the setting back when the server refuses the change", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "share_can_receive_link_emails") return Promise.resolve(true);
      if (cmd === "share_get_link_visit_emails") return Promise.resolve("every");
      return Promise.reject({ kind: "NotFound", message: "This link isn't active any more." });
    });
    render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted />);

    const select = await screen.findByLabelText(LINK_VISIT_EMAILS);
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "None" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save that. This link isn't active any more."));
    expect(screen.getByLabelText(LINK_VISIT_EMAILS)).toHaveTextContent("Every visit");
  });
  it("keeps only None while the account's First views email is off, saying why on hover", async () => {
    render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted firstViews={false} />);

    fireEvent.click(await screen.findByLabelText(LINK_VISIT_EMAILS));
    for (const name of ["Every visit", "First visit"]) {
      const option = await screen.findByRole("option", { name });
      expect(option).toHaveAttribute("data-disabled");
      expect(option).toHaveAttribute("title", VISIT_EMAILS_NEED_FIRST_VIEWS);
    }
    const none = screen.getByRole("option", { name: "None" });
    expect(none).not.toHaveAttribute("data-disabled");
    expect(none).not.toHaveAttribute("title");

    fireEvent.click(none);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_link_visit_emails", { shareToken: "tok", visits: "off" }),
    );
  });

  it("disables nothing while First views is on or not known", async () => {
    for (const firstViews of [true, null]) {
      const { unmount } = render(<LinkVisitEmailsSelect shareToken="tok" viewsCounted firstViews={firstViews} />);
      fireEvent.click(await screen.findByLabelText(LINK_VISIT_EMAILS));
      for (const name of ["Every visit", "First visit", "None"]) {
        expect(await screen.findByRole("option", { name })).not.toHaveAttribute("data-disabled");
      }
      unmount();
    }
  });

  it("follows the account switch beside it in the share dialog", async () => {
    render(<FirstViewEmailSwitch viewsCounted shareToken="tok" />);

    const account = await screen.findByRole("switch", { name: FIRST_VIEW_EMAIL });
    fireEvent.click(await screen.findByLabelText(LINK_VISIT_EMAILS));
    expect(await screen.findByRole("option", { name: "Every visit" })).not.toHaveAttribute("data-disabled");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(account);
    await waitFor(() => expect(account).toHaveAttribute("aria-checked", "false"));
    fireEvent.click(screen.getByLabelText(LINK_VISIT_EMAILS));
    expect(await screen.findByRole("option", { name: "Every visit" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("option", { name: "First visit" })).toHaveAttribute("data-disabled");
    expect(screen.getByRole("option", { name: "None" })).not.toHaveAttribute("data-disabled");
  });

  it("shows no link setting in the share dialog without a link token", async () => {
    render(<FirstViewEmailSwitch viewsCounted />);
    await screen.findByRole("switch", { name: FIRST_VIEW_EMAIL });
    expect(screen.queryByLabelText(LINK_VISIT_EMAILS)).toBeNull();
    expect(commands()).not.toContain("share_get_link_visit_emails");
  });
});
