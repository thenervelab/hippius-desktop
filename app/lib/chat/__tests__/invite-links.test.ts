import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";

import type { AcceptInviteOutcome } from "@/lib/tauri/chat";

const chatAcceptWorkspaceInvite = vi.fn<(tokenOrUrl: string) => Promise<AcceptInviteOutcome>>();
vi.mock("@/lib/tauri/chat", () => ({
  chatAcceptWorkspaceInvite: (tokenOrUrl: string) => chatAcceptWorkspaceInvite(tokenOrUrl),
}));

const acceptWorkspaceInvite = vi.fn<(client: MatrixClient, spaceId: string) => Promise<void>>();
const waitForJoinedRoom = vi.fn<(client: MatrixClient, roomId: string) => Promise<boolean>>();
vi.mock("@/lib/chat/spaces", () => ({
  acceptWorkspaceInvite: (client: MatrixClient, spaceId: string) => acceptWorkspaceInvite(client, spaceId),
  waitForJoinedRoom: (client: MatrixClient, roomId: string) => waitForJoinedRoom(client, roomId),
}));

const { redeemFailureMessage, redeemInviteLink } = await import("@/lib/chat/invite-links");

const joinRoom = vi.fn<(roomId: string) => Promise<unknown>>();
const client = { joinRoom } as unknown as MatrixClient;

describe("redeemInviteLink", () => {
  beforeEach(() => {
    chatAcceptWorkspaceInvite.mockReset();
    acceptWorkspaceInvite.mockReset().mockResolvedValue(undefined);
    waitForJoinedRoom.mockReset().mockResolvedValue(true);
    joinRoom.mockReset().mockResolvedValue({});
  });

  it("hands the pasted text to Rust, then joins the Space and every default channel it named", async () => {
    chatAcceptWorkspaceInvite.mockResolvedValue({ kind: "accepted", space_id: "!acme:h", room_ids: ["!general:h", "!random:h"] });

    const result = await redeemInviteLink(client, "https://console.hippius.com/chat/join/tok_12345678");

    expect(chatAcceptWorkspaceInvite).toHaveBeenCalledWith("https://console.hippius.com/chat/join/tok_12345678");
    expect(acceptWorkspaceInvite).toHaveBeenCalledWith(client, "!acme:h");
    expect(joinRoom.mock.calls.map(([id]) => id)).toEqual(["!general:h", "!random:h"]);
    // The shell reconciles the active workspace against the room list, so
    // the join only counts once that list knows the Space.
    expect(waitForJoinedRoom).toHaveBeenCalledWith(client, "!acme:h");
    expect(result).toEqual({ kind: "joined", spaceId: "!acme:h" });
  });

  it("a channel the bot could not invite to does not fail the join", async () => {
    chatAcceptWorkspaceInvite.mockResolvedValue({ kind: "accepted", space_id: "!acme:h", room_ids: ["!locked:h", "!open:h"] });
    joinRoom.mockImplementation((id) => (id === "!locked:h" ? Promise.reject(new Error("forbidden")) : Promise.resolve({})));

    await expect(redeemInviteLink(client, "tok_12345678")).resolves.toEqual({ kind: "joined", spaceId: "!acme:h" });
    expect(joinRoom).toHaveBeenCalledWith("!open:h");
  });

  it("passes Rust's unknown / expired verdicts through untouched and does no Matrix work", async () => {
    chatAcceptWorkspaceInvite.mockResolvedValueOnce({ kind: "unknown" });
    await expect(redeemInviteLink(client, "not a link")).resolves.toEqual({ kind: "unknown" });

    chatAcceptWorkspaceInvite.mockResolvedValueOnce({ kind: "expired" });
    await expect(redeemInviteLink(client, "tok_12345678")).resolves.toEqual({ kind: "expired" });

    expect(acceptWorkspaceInvite).not.toHaveBeenCalled();
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("a failed Space join surfaces as a rejection, not a silent 'joined'", async () => {
    chatAcceptWorkspaceInvite.mockResolvedValue({ kind: "accepted", space_id: "!acme:h", room_ids: [] });
    acceptWorkspaceInvite.mockRejectedValue(new Error("M_FORBIDDEN"));

    await expect(redeemInviteLink(client, "tok_12345678")).rejects.toThrow("M_FORBIDDEN");
  });
});

describe("redeemFailureMessage", () => {
  it("tells the two failures apart for the user", () => {
    expect(redeemFailureMessage({ kind: "unknown" })).toMatch(/not valid/);
    expect(redeemFailureMessage({ kind: "expired" })).toMatch(/expired|already been used/);
  });
});
