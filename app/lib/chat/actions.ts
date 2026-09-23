/**
 * Message-level actions the timeline needs: reactions, deletion, receipts,
 * retry. Sending and editing text live in `compose.ts` (next lot).
 */

import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  ReceiptType,
  RelationType,
  type Room,
} from "matrix-js-sdk";

import { reactionsFor } from "@/lib/chat/timeline";

/** Add our reaction with `key`, or remove it if we already reacted with it. */
export async function toggleReaction(client: MatrixClient, room: Room, event: MatrixEvent, key: string): Promise<void> {
  const targetId = event.getId();
  if (!targetId) return;
  const mine = reactionsFor(room, event, client.getUserId()).find((r) => r.key === key)?.myEventId;
  if (mine) {
    await client.redactEvent(room.roomId, mine);
    return;
  }
  await client.sendEvent(room.roomId, event.threadRootId ?? null, EventType.Reaction, {
    "m.relates_to": { rel_type: RelationType.Annotation, event_id: targetId, key },
  });
}

export async function deleteMessage(client: MatrixClient, room: Room, event: MatrixEvent, reason?: string): Promise<void> {
  const id = event.getId();
  if (!id) return;
  await client.redactEvent(room.roomId, event.threadRootId ?? null, id, undefined, reason ? { reason } : undefined);
}

/**
 * Mark the room read up to `event`: public `m.read` receipt plus the
 * `m.fully_read` marker (which drives the "New" line on next open).
 * No-op if that event is already our receipt target.
 */
export async function markReadUpTo(client: MatrixClient, room: Room, event: MatrixEvent): Promise<void> {
  const me = client.getUserId();
  const id = event.getId();
  if (!me || !id || event.status) return; // never receipt a local echo
  if (room.getEventReadUpTo(me) === id) return;
  await client.setRoomReadMarkers(room.roomId, id, event, event);
}

/**
 * Threaded read receipt (`thread_id` = the root). Deliberately leaves the
 * room's `m.fully_read` alone so the main timeline's "New" line stays put.
 */
export async function markThreadReadUpTo(client: MatrixClient, room: Room, event: MatrixEvent): Promise<void> {
  const me = client.getUserId();
  const id = event.getId();
  if (!me || !id || event.status || !event.threadRootId) return;
  const thread = room.getThread(event.threadRootId);
  if (thread && thread.getEventReadUpTo(me) === id) return;
  await client.sendReadReceipt(event, ReceiptType.Read);
}

/** Private receipt only: for muted rooms where we do not want to signal reading. */
export async function markReadPrivately(client: MatrixClient, event: MatrixEvent): Promise<void> {
  if (!event.getId() || event.status) return;
  await client.sendReadReceipt(event, ReceiptType.ReadPrivate);
}

export async function retrySend(client: MatrixClient, room: Room, event: MatrixEvent): Promise<void> {
  await client.resendEvent(event, room);
}

export function cancelSend(client: MatrixClient, event: MatrixEvent): void {
  client.cancelPendingEvent(event);
}

/**
 * Ensure an event is loaded (for a permalink jump). Resolves the event or
 * `null`; the SDK fetches a window around it into a separate timeline set.
 */
export async function ensureEventLoaded(client: MatrixClient, room: Room, eventId: string): Promise<MatrixEvent | null> {
  const local = room.findEventById(eventId);
  if (local) return local;
  const timeline = await client.getEventTimeline(room.getUnfilteredTimelineSet(), eventId);
  return timeline?.getEvents().find((e) => e.getId() === eventId) ?? null;
}
