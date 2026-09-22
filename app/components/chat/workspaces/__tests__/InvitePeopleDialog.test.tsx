import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";

import { invitePeopleOpenAtom } from "@/components/chat/chat-ui-atoms";
import type { WorkspacesState } from "@/components/chat/hooks/useWorkspaces";
import { chatConfigAtom } from "@/app/lib/global-atoms/chatAtoms";
import type { ChatConfig, InviteLinkOutcome } from "@/lib/tauri/chat";

const chatCreateWorkspaceInvite = vi.fn<(spaceId: string) => Promise<InviteLinkOutcome>>();
vi.mock("@/lib/tauri/chat", () => ({
  chatCreateWorkspaceInvite: (spaceId: string) => chatCreateWorkspaceInvite(spaceId),
}));

const inviteToWorkspace = vi.fn();
vi.mock("@/lib/chat/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/spaces")>()),
  inviteToWorkspace: (...args: unknown[]) => inviteToWorkspace(...args),
  defaultChannelIds: () => ["!general:hippius.com"],
  searchPeople: async () => [],
}));
vi.mock("@/lib/chat/rooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/rooms")>()),
  knownUsers: () => [],
}));
vi.mock("@/components/chat/UserAvatar", () => ({ default: () => <span data-testid="avatar" /> }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { default: InvitePeopleDialog } = await import("@/components/chat/workspaces/InvitePeopleDialog");

const space = { roomId: "!acme:hippius.com", getJoinedMembers: () => [{ userId: "@me:hippius.com" }] };
const client = {
  getUserId: () => "@me:hippius.com",
  getRoom: (id: string) => (id === "!acme:hippius.com" ? space : null),
} as unknown as MatrixClient;

const config = { enabled: true, serverName: "hippius.com" } as ChatConfig;

function mount(myRole: "owner" | "admin" | "member" = "admin") {
  const workspaces = { active: { id: "!acme:hippius.com", name: "Acme", myRole } } as unknown as WorkspacesState;
  const store = createStore();
  store.set(chatConfigAtom, config);
  store.set(invitePeopleOpenAtom, true);
  render(
    <Provider store={store}>
      <InvitePeopleDialog client={client} workspaces={workspaces} />
    </Provider>,
  );
  return store;
}

describe("InvitePeopleDialog", () => {
  beforeEach(() => {
    chatCreateWorkspaceInvite.mockReset();
    inviteToWorkspace.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it("members cannot invite: the form is replaced by an explanation", () => {
    mount("member");
    expect(screen.getByText(/Only workspace admins and owners can invite people/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("mints the link through Rust for the active Space and offers to copy it", async () => {
    chatCreateWorkspaceInvite.mockResolvedValue({
      kind: "link",
      token: "tok_12345678",
      url: "https://console.hippius.com/chat/join/tok_12345678",
      expires_at: "2030-01-01T00:00:00Z",
      max_uses: null,
      uses: 0,
      space_id: "!acme:hippius.com",
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    mount();
    fireEvent.click(screen.getByRole("button", { name: /Create an invite link/ }));

    expect(chatCreateWorkspaceInvite).toHaveBeenCalledWith("!acme:hippius.com");
    const field = await screen.findByLabelText("Invite link");
    expect(field).toHaveValue("https://console.hippius.com/chat/join/tok_12345678");

    fireEvent.click(screen.getByRole("button", { name: /Copy invite link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://console.hippius.com/chat/join/tok_12345678"));
    expect(screen.getByRole("button", { name: /Done/ })).toBeInTheDocument();
  });

  it("a backend without the endpoint hides the link button instead of erroring", async () => {
    chatCreateWorkspaceInvite.mockResolvedValue({ kind: "unavailable" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Create an invite link/ }));
    expect(await screen.findByText(/Invite links are not available yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create an invite link/ })).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a typed handle is completed with the Rust-provided server name and invited with the default channels", async () => {
    inviteToWorkspace.mockResolvedValue({ invited: ["@bob:hippius.com"], failed: [] });
    const store = mount();

    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "bob" } });
    const option = await screen.findByRole("option", { name: /@bob:hippius.com/ });
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: /Send invitation/ }));

    await waitFor(() => expect(inviteToWorkspace).toHaveBeenCalledWith(client, "!acme:hippius.com", ["@bob:hippius.com"], ["!general:hippius.com"]));
    await waitFor(() => expect(store.get(invitePeopleOpenAtom)).toBe(false));
    expect(toast.success).toHaveBeenCalledWith("Invited 1 person to Acme");
  });
});
