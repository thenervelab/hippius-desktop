/**
 * Redeeming a workspace invite link inside the desktop.
 *
 * The console lands invite links on `/chat/join/<token>`; the desktop has no
 * URL routes, so the same token (or the whole pasted link) is redeemed from
 * a field in the "Join a workspace" dialog. The backend half — parsing the
 * token out of the link, the bot invite, the 404/410 mapping — is Rust's
 * (`chat::backend::accept_invite`); this module does the Matrix half the
 * console's `redeemInviteToken` does: accept the Space invite the bot just
 * sent, join the default channels it named, and wait until the room list
 * knows the Space so the shell does not re-pick another workspace.
 */

import type { MatrixClient } from "matrix-js-sdk";

import { acceptWorkspaceInvite, waitForJoinedRoom } from "@/lib/chat/spaces";
import { type AcceptInviteOutcome, chatAcceptWorkspaceInvite } from "@/lib/tauri/chat";

export type RedeemInviteResult = { kind: "joined"; spaceId: string } | { kind: "unknown" } | { kind: "expired" };

/** The sentence to show for a redeem that did not end in a join. */
export function redeemFailureMessage(result: Exclude<RedeemInviteResult, { kind: "joined" }>): string {
  switch (result.kind) {
    case "unknown":
      return "This invitation link is not valid.";
    case "expired":
      return "This invitation link has expired or has already been used.";
  }
}

/**
 * Join the Space (and default channels) a backend `accepted` outcome
 * names. Channel joins are best effort: the Space is what matters, and a
 * channel may already have come in through the Space's pending invites.
 */
export async function joinAcceptedWorkspace(
  client: MatrixClient,
  accepted: Extract<AcceptInviteOutcome, { kind: "accepted" }>,
): Promise<string> {
  await acceptWorkspaceInvite(client, accepted.space_id);
  for (const roomId of accepted.room_ids) {
    try {
      await client.joinRoom(roomId);
    } catch {
      // Already joined through the Space, or a channel the bot could not invite to.
    }
  }
  await waitForJoinedRoom(client, accepted.space_id);
  return accepted.space_id;
}

/** Redeem a pasted invite link or token end to end. */
export async function redeemInviteLink(client: MatrixClient, tokenOrUrl: string): Promise<RedeemInviteResult> {
  const outcome = await chatAcceptWorkspaceInvite(tokenOrUrl);
  if (outcome.kind !== "accepted") return outcome;
  const spaceId = await joinAcceptedWorkspace(client, outcome);
  return { kind: "joined", spaceId };
}
