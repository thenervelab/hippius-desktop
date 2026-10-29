import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { toast } from "sonner";

import ShareLinkEmailsSetting from "../ShareLinkEmailsSetting";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PREFS = { firstViews: true, comments: true, digest: "weekly" };

describe("ShareLinkEmailsSetting", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(toast.error).mockReset();
  });

  it("shows the three preferences the server holds", async () => {
    invokeMock.mockResolvedValueOnce({ ...PREFS, comments: false });
    render(<ShareLinkEmailsSetting />);

    expect(await screen.findByRole("switch", { name: "First views" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "New comments" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Summary")).toBeInTheDocument();
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

  it("says so when the preferences cannot be read", async () => {
    invokeMock.mockRejectedValueOnce(new Error("offline"));
    render(<ShareLinkEmailsSetting />);
    expect(await screen.findByText("Couldn't load these settings right now.")).toBeInTheDocument();
  });
});
