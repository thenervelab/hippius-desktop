/**
 * Thread selectors. A thread is a root event plus its `m.thread` replies;
 * the SDK keeps a `Thread` object per root in each room. These helpers turn
 * that into plain data for the sidebar "Threads" section and the thread
 * panel.
 */

import {
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type Thread,
  KnownMembership,
  NotificationCountType,
} from "matrix-js-sdk";

export interface ThreadSummary {
  roomId: string;
  roomName: string;
  rootEventId: string;
  /** First line of the root message, for the list. */
  rootPreview: string;
  rootSenderName: string;
  replyCount: number;
  unread: number;
  highlight: number;
  lastReplyTs: number;
  participantIds: string[];
}

/** Plain-text preview of an event body, first line, trimmed. */
export function eventPreview(event: MatrixEvent | undefined, maxLength = 120): string {
  if (!event) return "";
  if (event.isRedacted()) return "Message deleted";
  if (event.isDecryptionFailure()) return "Unable to decrypt";
  const content = event.getContent();
  const body = typeof content.body === "string" ? content.body : "";
  const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1)}…` : firstLine;
}

export function summariseThread(room: Room, thread: Thread): ThreadSummary {
  const root = thread.rootEvent;
  const last = thread.lastReply() ?? root;
  const participants = new Set<string>();
  for (const event of thread.liveTimeline.getEvents()) {
    const sender = event.getSender();
    if (sender) participants.add(sender);
  }
  return {
    roomId: room.roomId,
    roomName: room.name,
    rootEventId: thread.id,
    rootPreview: eventPreview(root),
    rootSenderName: root ? room.getMember(root.getSender() ?? "")?.name ?? root.getSender() ?? "" : "",
    replyCount: thread.length,
    unread: room.getThreadUnreadNotificationCount(thread.id, NotificationCountType.Total),
    highlight: room.getThreadUnreadNotificationCount(thread.id, NotificationCountType.Highlight),
    lastReplyTs: last?.getTs() ?? 0,
    participantIds: [...participants],
  };
}

/**
 * Threads the user is part of, most recent first. `unreadOnly` narrows to
 * threads with unread replies (the sidebar section).
 */
export function participatingThreads(client: MatrixClient, unreadOnly: boolean): ThreadSummary[] {
  const out: ThreadSummary[] = [];
  for (const room of client.getVisibleRooms()) {
    if (room.getMyMembership() !== KnownMembership.Join) continue;
    for (const thread of room.getThreads()) {
      if (!thread.hasCurrentUserParticipated) continue;
      const summary = summariseThread(room, thread);
      if (unreadOnly && summary.unread === 0) continue;
      out.push(summary);
    }
  }
  out.sort((a, b) => b.lastReplyTs - a.lastReplyTs);
  return out;
}

/** Thread replies in order, without the root. */
export function threadReplies(thread: Thread): MatrixEvent[] {
  return thread.liveTimeline.getEvents().filter((event) => event.getId() !== thread.id);
}
