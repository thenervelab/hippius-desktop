import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";

import type { RedeemInviteResult } from "@/lib/chat/invite-links";

const redeemInviteLink = vi.fn<(client: MatrixClient, input: string) => Promise<RedeemInviteResult>>();
vi.mock("@/lib/chat/invite-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/invite-links")>()),
  redeemInviteLink: (client: MatrixClient, input: string) => redeemInviteLink(client, input),
}));
vi.mock("@/components/chat/workspaces/WorkspaceAvatar", () => ({ default: () => <span /> }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { default: JoinWorkspaceList } = await import("@/components/chat/workspaces/JoinWorkspaceList");

const client = { getUserId: () => "@me:hippius.com" } as unknown as MatrixClient;

function mount() {
  const onJoined = vi.fn();
  render(<JoinWorkspaceList client={client} invites={[]} inCommunity onJoined={onJoined} />);
  return onJoined;
}

describe("JoinWorkspaceList: paste an invite link", () => {
  beforeEach(() => {
    redeemInviteLink.mockReset();
    toast.success.mockReset();
  });

  it("redeems the pasted link and lands in the joined workspace", async () => {
    redeemInviteLink.mockResolvedValue({ kind: "joined", spaceId: "!acme:hippius.com" });
    const onJoined = mount();

    const field = screen.getByLabelText(/Have an invite link/);
    const join = screen.getByRole("button", { name: /Join/ });
    expect(join).toBeDisabled();
    fireEvent.change(field, { target: { value: "  https://console.hippius.com/chat/join/tok_12345678 " } });
    fireEvent.click(join);

    await waitFor(() => expect(onJoined).toHaveBeenCalledWith("!acme:hippius.com"));
    expect(redeemInviteLink).toHaveBeenCalledWith(client, "https://console.hippius.com/chat/join/tok_12345678");
    expect(field).toHaveValue("");
  });

  it("an expired link is reported next to the field, and typing clears it", async () => {
    redeemInviteLink.mockResolvedValue({ kind: "expired" });
    const onJoined = mount();

    const field = screen.getByLabelText(/Have an invite link/);
    fireEvent.change(field, { target: { value: "tok_12345678" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);

    expect(await screen.findByRole("alert")).toHaveTextContent(/expired|already been used/);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(onJoined).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "tok_123456789" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
