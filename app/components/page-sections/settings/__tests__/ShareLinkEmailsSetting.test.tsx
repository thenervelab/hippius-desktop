import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { getDefaultStore } from "jotai";
import { toast } from "sonner";

import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";

import ShareLinkEmailsSetting from "../ShareLinkEmailsSetting";
import { LINK_EMAILS_NEED_SIGN_IN } from "../../drive/SecureLinkSection";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PREFS = { firstViews: true, comments: true, digest: "weekly" };
/** What a server with the newer emails sends back. */
const NEWER = { returnVisits: true, ndaAccepts: false, gateRefusals: true };

const NEWER_ROWS = ["Return visits", "NDA accepted", "Refused viewers"];

function setCaps(caps: Partial<ServerCapabilities> | null) {
  act(() => getDefaultStore().set(serverCapabilitiesAtom, caps as ServerCapabilities | null));
}

/** Answers `share_can_receive_link_emails` itself; every other command from `invokeMock`. */
const canReceive = vi.hoisted(() => ({ value: true as boolean | Error }));
vi.mock("@/app/lib/tauri/shareInsights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/tauri/shareInsights")>();
  return {
    ...actual,
    canReceiveLinkEmails: () =>
      canReceive.value instanceof Error ? Promise.reject(canReceive.value) : Promise.resolve(canReceive.value),
  };
});

describe("ShareLinkEmailsSetting", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.error).mockReset();
    canReceive.value = true;
    setCaps({ shares: true, share_notifications: true });
  });

  it("shows an access-key account one line instead of the switches", async () => {
    canReceive.value = false;
    render(<ShareLinkEmailsSetting />);

    expect(await screen.findByText(LINK_EMAILS_NEED_SIGN_IN)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Summary")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("says it could not load when it cannot tell whether the account has an email", async () => {
    canReceive.value = new Error("offline");
    render(<ShareLinkEmailsSetting />);
    expect(await screen.findByText("Couldn't load these settings right now.")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the three preferences the server holds", async () => {
    invokeMock.mockResolvedValueOnce({ ...PREFS, comments: false });
    render(<ShareLinkEmailsSetting />);

    expect(await screen.findByRole("switch", { name: "First views" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "New comments" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.queryByText(LINK_EMAILS_NEED_SIGN_IN)).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("share_get_notification_preferences");
  });

  it("saves each change at once with the whole set", async () => {
    invokeMock.mockResolvedValueOnce(PREFS).mockResolvedValueOnce(undefined);
    render(<ShareLinkEmailsSetting />);

    fireEvent.click(await screen.findByRole("switch", { name: "New comments" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_notification_preferences", {
        preferences: { firstViews: true, comments: false, digest: "weekly" },
      }),
    );
    expect(screen.getByRole("switch", { name: "New comments" })).toHaveAttribute("aria-checked", "false");
  });

  it("puts a change back when the server refuses it", async () => {
    invokeMock.mockResolvedValueOnce(PREFS).mockRejectedValueOnce({ kind: "Api", message: "Nope." });
    render(<ShareLinkEmailsSetting />);

    fireEvent.click(await screen.findByRole("switch", { name: "First views" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save that. Nope."));
    expect(screen.getByRole("switch", { name: "First views" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows none of the newer emails while the server does not send them, even when the preferences carry them", async () => {
    invokeMock.mockResolvedValueOnce({ ...PREFS, ...NEWER });
    render(<ShareLinkEmailsSetting />);

    await screen.findByRole("switch", { name: "First views" });
    for (const name of NEWER_ROWS) expect(screen.queryByRole("switch", { name })).toBeNull();
    expect(screen.getByText("An email when one of your links is opened for the first time.")).toBeInTheDocument();
  });

  it("shows Return visits only with share_link_notifications", async () => {
    setCaps({ shares: true, share_notifications: true, share_link_notifications: true });
    invokeMock.mockResolvedValueOnce({ ...PREFS, ...NEWER });
    render(<ShareLinkEmailsSetting />);

    expect(await screen.findByRole("switch", { name: "Return visits" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("switch", { name: "NDA accepted" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Refused viewers" })).toBeNull();
    // First views also decides the every-visit emails, so it says so.
    expect(screen.getByText(/after each visit on links set to Every visit/)).toBeInTheDocument();
  });

  it("shows NDA accepted and Refused viewers only with share_event_notifications", async () => {
    setCaps({ shares: true, share_notifications: true, share_event_notifications: true });
    invokeMock.mockResolvedValueOnce({ ...PREFS, ...NEWER });
    render(<ShareLinkEmailsSetting />);

    expect(await screen.findByRole("switch", { name: "NDA accepted" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Refused viewers" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("switch", { name: "Return visits" })).toBeNull();
  });

  it("shows no switch for an email the server advertises but did not send a choice for", async () => {
    setCaps({
      shares: true,
      share_notifications: true,
      share_link_notifications: true,
      share_event_notifications: true,
    });
    invokeMock.mockResolvedValueOnce(PREFS);
    render(<ShareLinkEmailsSetting />);

    await screen.findByRole("switch", { name: "First views" });
    for (const name of NEWER_ROWS) expect(screen.queryByRole("switch", { name })).toBeNull();
  });

  it("saves a newer email with the rest, and never adds one the server did not send", async () => {
    setCaps({
      shares: true,
      share_notifications: true,
      share_link_notifications: true,
      share_event_notifications: true,
    });
    invokeMock.mockResolvedValueOnce({ ...PREFS, ndaAccepts: true }).mockResolvedValueOnce(undefined);
    render(<ShareLinkEmailsSetting />);

    fireEvent.click(await screen.findByRole("switch", { name: "NDA accepted" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("share_set_notification_preferences", {
        preferences: { firstViews: true, comments: true, digest: "weekly", ndaAccepts: false },
      }),
    );
    expect(screen.getByRole("switch", { name: "NDA accepted" })).toHaveAttribute("aria-checked", "false");
  });

  it("says so when the preferences cannot be read", async () => {
    invokeMock.mockRejectedValueOnce(new Error("offline"));
    render(<ShareLinkEmailsSetting />);
    expect(await screen.findByText("Couldn't load these settings right now.")).toBeInTheDocument();
  });
});
