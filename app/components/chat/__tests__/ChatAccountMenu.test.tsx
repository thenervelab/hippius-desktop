import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";

import { CHAT_SIGN_OUT_CONFIRM, CHAT_SIGN_OUT_HEADING } from "@/lib/chat/sign-out";

/**
 * The account menu is the one place a signed-in user can leave the chat
 * from the UI, so what matters is behaviour: the sign-out never fires
 * without the confirm, the confirm's copy is the shared one, and "other
 * devices" goes to the IdP's sessions page — or is absent when the server
 * advertises none.
 */

const signOut = vi.fn(async () => undefined);
vi.mock("@/components/chat/ChatProvider", () => ({
  useChat: () => ({ signOut }),
}));

const openExternalLink = vi.fn<(url: string) => Promise<void>>(async () => undefined);
vi.mock("@/app/lib/utils/tauri", () => ({
  openExternalLink: (url: string) => openExternalLink(url),
}));

const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { default: ChatAccountMenu } = await import("@/components/chat/ChatAccountMenu");

function makeClient(accountManagementUri: string | undefined) {
  return {
    getUserId: () => "@alice:hippius.com",
    getAuthMetadata: vi.fn(async () => ({ account_management_uri: accountManagementUri })),
  } as unknown as MatrixClient;
}

async function openMenu() {
  const trigger = screen.getByRole("button", { name: /Chat account: signed in as @alice:hippius.com/ });
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  return screen.findByRole("menu");
}

describe("ChatAccountMenu", () => {
  beforeEach(() => {
    signOut.mockClear();
    openExternalLink.mockClear();
    toast.error.mockClear();
  });

  it("names the signed-in account and asks for confirmation before signing out", async () => {
    render(<ChatAccountMenu client={makeClient(undefined)} />);
    await openMenu();
    expect(screen.getByText("Signed in as")).toBeInTheDocument();
    expect(screen.getByText("@alice:hippius.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out of chat/ }));
    // Only the dialog so far: nothing has been revoked.
    expect(signOut).not.toHaveBeenCalled();
    expect(await screen.findByText(CHAT_SIGN_OUT_HEADING)).toBeInTheDocument();
    expect(screen.getByText(CHAT_SIGN_OUT_CONFIRM)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Sign out$/ }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(CHAT_SIGN_OUT_HEADING)).toBeNull());
  });

  it("cancelling the confirm keeps the session", async () => {
    render(<ChatAccountMenu client={makeClient(undefined)} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out of chat/ }));
    await screen.findByText(CHAT_SIGN_OUT_HEADING);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(screen.queryByText(CHAT_SIGN_OUT_HEADING)).toBeNull());
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a failed sign-out is reported and the dialog stays open for a retry", async () => {
    signOut.mockRejectedValueOnce(new Error("keyring locked"));
    render(<ChatAccountMenu client={makeClient(undefined)} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out of chat/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Sign out$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("keyring locked"));
    expect(screen.getByText(CHAT_SIGN_OUT_HEADING)).toBeInTheDocument();
  });

  it("'Sign out other devices' opens the IdP sessions list in the system browser", async () => {
    const client = makeClient("https://auth.hippius.com/account/");
    render(<ChatAccountMenu client={client} />);
    await openMenu();
    const item = await screen.findByRole("menuitem", { name: /Sign out other devices/ });
    fireEvent.click(item);
    expect(openExternalLink).toHaveBeenCalledTimes(1);
    const opened = new URL(openExternalLink.mock.calls[0][0]);
    expect(opened.origin).toBe("https://auth.hippius.com");
    expect(opened.searchParams.get("action")).toBe("org.matrix.sessions_list");
    expect(signOut).not.toHaveBeenCalled();
  });

  it("hides 'other devices' when the server advertises no account-management page", async () => {
    const client = makeClient(undefined);
    render(<ChatAccountMenu client={client} />);
    await openMenu();
    await waitFor(() => expect(client.getAuthMetadata).toHaveBeenCalled());
    expect(screen.queryByRole("menuitem", { name: /Sign out other devices/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Sign out of chat/ })).toBeInTheDocument();
  });
});
