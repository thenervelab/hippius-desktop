import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";

import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";
import { LINK_VISIT_EMAILS, LinkVisitEmailsSelect } from "../SecureLinkSection";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Answers `share_can_receive_link_emails` and the link's setting; anything else from `invokeMock`. */
const answers = vi.hoisted(() => ({
  canReceive: true as boolean,
  visits: "first" as string | null,
}));

function wire() {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "share_can_receive_link_emails") return Promise.resolve(answers.canReceive);
    if (cmd === "share_get_link_visit_emails") return Promise.resolve(answers.visits);
    if (cmd === "share_set_link_visit_emails") return Promise.resolve(undefined);
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

  it("shows nothing while the link does not count views", async () => {
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
});
