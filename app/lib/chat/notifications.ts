/**
 * Turning a Matrix timeline event into the report Rust decides on.
 *
 * The desktop notification policy (mentions in channels, every DM, unless
 * the "Chat" preference is off or the room is on screen) lives in Rust —
 * `chat::notify::decide_notify`. This module only establishes the Matrix
 * facts Rust cannot see: is the event a fresh, decrypted message from
 * someone else that the account's push rules flag, is it a mention, is the
 * room a direct message. Everything here is pure so the whole table is
 * unit-tested without a client.
 */

import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

import { dmPartnerOf, roomLabel } from "@/lib/chat/rooms";
import { eventPreview } from "@/lib/chat/threads";
import { isMessageLike, messageBody } from "@/lib/chat/timeline";

/**
 * Wire shape of Rust's `chat::notify::IncomingMessage` (camelCase). Every
 * field is a fact about the message or the UI; none is a decision.
 */
export interface IncomingMessage {
  roomId: string;
  roomName: string;
  senderName: string;
  body: string;
  /** Direct message rather than a channel. */
  isDirect: boolean;
  /** The push rules highlighted it: a mention of the user or a keyword. */
  isMention: boolean;
  /** The user has this room open in the chat surface right now. */
  roomIsOpen: boolean;
}

/**
 * Events older than this are history the client is catching up on (a
 * reconnect after sleep, an initial sync), not messages arriving now.
 * Notifying for them would replay the backlog as a burst of banners.
 */
export const HISTORY_WINDOW_MS = 60_000;

/** Body shown for a message with no text (an attachment, a sticker). */
export const ATTACHMENT_BODY = "Sent an attachment";

export interface ClassifyContext {
  /** `Date.now()` at the time of the event; injected so the window is testable. */
  now: number;
  /** `directRoomMap(client)`: room id → DM partner. */
  direct: Map<string, string>;
  /** Room shown in the chat surface, or `null` when chat is not on screen. */
  openRoomId: string | null;
}

/**
 * The report for an incoming event, or `null` when it is not a message
 * the user could be told about at all: our own, a local echo, a
 * non-message event, history, still encrypted, or one the account's push
 * rules (which already know muted rooms and keywords) do not flag.
 * The result carries `isMention` / `isDirect` so Rust can apply the
 * "mentions and DMs" rule rather than this side pre-deciding it.
 */
export function classifyIncoming(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  ctx: ClassifyContext,
): IncomingMessage | null {
  const myUserId = client.getUserId() ?? "";
  const sender = event.getSender();
  if (!sender || sender === myUserId) return null;
  if (event.status) return null; // local echo
  if (
    !isMessageLike(event) ||
    event.isDecryptionFailure() ||
    event.isRedacted()
  )
    return null;
  if (event.getTs() < ctx.now - HISTORY_WINDOW_MS) return null;
  const actions = client.getPushActionsForEvent(event);
  if (!actions?.notify) return null;

  const dmUserId = dmPartnerOf(room, ctx.direct, myUserId);
  const isDirect = dmUserId !== null;
  const senderName = room.getMember(sender)?.name ?? sender;
  const roomName = isDirect
    ? senderName
    : roomLabel({ kind: "channel", name: room.name });
  const text = messageBody(event).text.trim();

  return {
    roomId: room.roomId,
    roomName,
    senderName,
    body: text ? eventPreview(event, 120) : ATTACHMENT_BODY,
    isDirect,
    isMention: Boolean(actions.tweaks?.highlight),
    roomIsOpen: ctx.openRoomId === room.roomId,
  };
}
