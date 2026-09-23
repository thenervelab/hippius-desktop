/**
 * Timeline selectors: turn a room's live timeline into the plain shapes the
 * message list renders (day separators, sender grouping, the "New" line,
 * reactions, attachments). No React here so the shapes are unit-testable.
 */

import {
  type IContent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  EventStatus,
  EventType,
  MsgType,
  RelationType,
} from "matrix-js-sdk";

import { type EncryptedFile, GIF_CONTENT_FLAG } from "@/lib/chat/attachments";

/** Two messages from the same sender within this window are one group. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type TimelineItem =
  | { kind: "day"; key: string; ts: number }
  | { kind: "new-line"; key: string }
  | {
      kind: "message";
      key: string;
      event: MatrixEvent;
      /** First message of a sender group: show avatar + name + time. */
      groupStart: boolean;
    }
  | { kind: "state"; key: string; event: MatrixEvent; text: string };

export interface Reaction {
  key: string;
  count: number;
  /** Sender ids, in arrival order. */
  senders: string[];
  /** The current user's own reaction event, when present (for toggling). */
  myEventId: string | null;
}

export interface Attachment {
  msgtype: MsgType.Image | MsgType.File | MsgType.Video | MsgType.Audio;
  name: string;
  mimetype: string | null;
  size: number | null;
  /** Plain mxc for unencrypted rooms. */
  url: string | null;
  /** EncryptedFile descriptor for encrypted rooms. */
  file: EncryptedFile | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  thumbnailFile: EncryptedFile | null;
  /** Animated GIF (`image/gif`) or a silent video standing in for one. */
  gif: boolean;
}

// ---------------------------------------------------------------------------
// Event classification

/** Does this event appear as a row in the message list at all? */
export function isRenderable(event: MatrixEvent): boolean {
  if (event.isRelation(RelationType.Replace)) return false; // edits fold into their target
  if (event.isRelation(RelationType.Annotation)) return false; // reactions fold into their target
  if (event.getType() === EventType.Reaction) return false;
  if (event.threadRootId && !event.isThreadRoot) return false; // thread replies live in the panel
  const type = event.getType();
  if (type === EventType.RoomMessage || type === EventType.RoomMessageEncrypted || type === EventType.Sticker) {
    return true;
  }
  if (event.isDecryptionFailure()) return true;
  return type === EventType.RoomMember || type === EventType.RoomTopic || type === EventType.RoomName || type === EventType.RoomCreate;
}

export function isMessageLike(event: MatrixEvent): boolean {
  const type = event.getType();
  return type === EventType.RoomMessage || type === EventType.RoomMessageEncrypted || type === EventType.Sticker || event.isDecryptionFailure();
}

/** Human line for a state event, or `null` to hide it. */
export function stateEventText(room: Room, event: MatrixEvent): string | null {
  const sender = room.getMember(event.getSender() ?? "")?.name ?? event.getSender() ?? "Someone";
  switch (event.getType()) {
    case EventType.RoomMember: {
      const content = event.getContent();
      const prev = event.getPrevContent();
      const target = (content.displayname as string | undefined) ?? event.getStateKey() ?? "";
      if (content.membership === "join" && prev.membership !== "join") return `${target} joined`;
      if (content.membership === "leave" && prev.membership === "join") {
        return event.getSender() === event.getStateKey() ? `${target} left` : `${sender} removed ${target}`;
      }
      if (content.membership === "invite") return `${sender} invited ${target}`;
      if (content.membership === "ban") return `${sender} banned ${target}`;
      if (content.membership === "join" && prev.membership === "join") {
        if (content.displayname !== prev.displayname) return `${prev.displayname ?? target} is now ${target}`;
        if (content.avatar_url !== prev.avatar_url) return `${target} changed their avatar`;
      }
      return null;
    }
    case EventType.RoomTopic: {
      const topic = event.getContent().topic as string | undefined;
      return topic ? `${sender} set the topic: ${topic}` : `${sender} removed the topic`;
    }
    case EventType.RoomName:
      return `${sender} renamed the channel to ${event.getContent().name as string}`;
    case EventType.RoomCreate:
      return `${sender} created the channel`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Grouping

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export interface BuildItemsOptions {
  /** Event id of the read marker; a "New" line goes right after it. */
  readMarkerEventId?: string | null;
  /** Do not draw "New" before messages from this user (our own). */
  myUserId?: string | null;
}

/**
 * Turn a chronologically ordered event list into list items. Grouping resets
 * on a new day, a new sender, a state event, or a gap of `GROUP_WINDOW_MS`.
 */
export function buildTimelineItems(room: Room, events: readonly MatrixEvent[], opts: BuildItemsOptions = {}): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDay: string | null = null;
  let lastSender: string | null = null;
  let lastTs = 0;
  let newLineDrawn = false;
  const marker = opts.readMarkerEventId ?? null;
  // "New" applies to events after the marker. If the marker is unknown or not
  // in this window we cannot place it, so nothing is flagged as new.
  let afterMarker = false;
  const markerInList = marker !== null && events.some((e) => e.getId() === marker);

  for (const event of events) {
    if (!isRenderable(event)) {
      if (markerInList && event.getId() === marker) afterMarker = true;
      continue;
    }
    const id = event.getId() ?? event.getTxnId() ?? `${event.getTs()}`;
    const ts = event.getTs();
    const day = dayKey(ts);
    if (day !== lastDay) {
      items.push({ kind: "day", key: `day-${day}`, ts });
      lastDay = day;
      lastSender = null;
    }

    const isMine = Boolean(opts.myUserId) && event.getSender() === opts.myUserId;
    if (afterMarker && !newLineDrawn && !isMine) {
      items.push({ kind: "new-line", key: "new-line" });
      newLineDrawn = true;
      lastSender = null;
    }

    if (isMessageLike(event)) {
      const sender = event.getSender() ?? "";
      const groupStart = sender !== lastSender || ts - lastTs > GROUP_WINDOW_MS;
      items.push({ kind: "message", key: id, event, groupStart });
      lastSender = sender;
      lastTs = ts;
    } else {
      const text = stateEventText(room, event);
      if (text) items.push({ kind: "state", key: id, event, text });
      lastSender = null;
    }

    if (markerInList && event.getId() === marker) afterMarker = true;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Reactions and attachments

export function reactionsFor(room: Room, event: MatrixEvent, myUserId: string | null): Reaction[] {
  const id = event.getId();
  if (!id) return [];
  const relations = room.getUnfilteredTimelineSet().relations.getChildEventsForEvent(id, RelationType.Annotation, EventType.Reaction);
  const sorted = relations?.getSortedAnnotationsByKey();
  if (!sorted) return [];
  const out: Reaction[] = [];
  for (const [key, set] of sorted) {
    const senders: string[] = [];
    let myEventId: string | null = null;
    for (const reaction of set) {
      if (reaction.isRedacted()) continue;
      const sender = reaction.getSender();
      if (!sender) continue;
      senders.push(sender);
      if (sender === myUserId) myEventId = reaction.getId() ?? null;
    }
    if (senders.length > 0) out.push({ key, count: senders.length, senders, myEventId });
  }
  return out;
}

export function attachmentOf(event: MatrixEvent): Attachment | null {
  const content = event.getContent();
  const msgtype = content.msgtype as string | undefined;
  if (msgtype !== MsgType.Image && msgtype !== MsgType.File && msgtype !== MsgType.Video && msgtype !== MsgType.Audio) {
    return null;
  }
  const info = (content.info ?? {}) as Record<string, unknown>;
  const file = (content.file as EncryptedFile | undefined) ?? null;
  const thumbnailFile = (info.thumbnail_file as EncryptedFile | undefined) ?? null;
  return {
    msgtype,
    name: (content.filename as string | undefined) ?? (content.body as string | undefined) ?? "file",
    mimetype: typeof info.mimetype === "string" ? info.mimetype : null,
    size: typeof info.size === "number" ? info.size : null,
    url: typeof content.url === "string" ? content.url : null,
    file,
    width: typeof info.w === "number" ? info.w : null,
    height: typeof info.h === "number" ? info.h : null,
    thumbnailUrl: typeof info.thumbnail_url === "string" ? info.thumbnail_url : null,
    thumbnailFile,
    gif: (msgtype === MsgType.Image && info.mimetype === "image/gif") || (msgtype === MsgType.Video && content[GIF_CONTENT_FLAG] === true),
  };
}

/**
 * Text to show above an attachment, or `null` when there is none.
 *
 * Matrix puts the filename in `body` when the sender typed no caption (and
 * `sendFile` does the same), so a bare filename is not a caption: the card
 * already shows the name. Only a `body` that differs from the filename is.
 * Compared trimmed so a trailing newline from a client does not resurrect
 * the duplicate line.
 */
export function attachmentCaption(body: string, attachment: Attachment): string | null {
  const text = body.trim();
  if (!text || text === attachment.name.trim()) return null;
  return text;
}

// ---------------------------------------------------------------------------
// Message body

export interface MessageBody {
  /** Plain text (post-edit). */
  text: string;
  /** Sanitised HTML if the sender provided `formatted_body`; rendered via our markdown pipeline instead. */
  formatted: string | null;
  edited: boolean;
  redacted: boolean;
  decryptionFailed: boolean;
  /** `m.emote` renders "* name does something". */
  emote: boolean;
  notice: boolean;
  /** Reply-to event id (`m.in_reply_to`) when the message is a reply outside a thread. */
  replyToId: string | null;
}

export function messageBody(event: MatrixEvent): MessageBody {
  if (event.isRedacted()) {
    return { text: "", formatted: null, edited: false, redacted: true, decryptionFailed: false, emote: false, notice: false, replyToId: null };
  }
  if (event.isDecryptionFailure()) {
    return { text: "", formatted: null, edited: false, redacted: false, decryptionFailed: true, emote: false, notice: false, replyToId: null };
  }
  const content: IContent = event.getContent();
  const relation = event.getWireContent()?.["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string }; rel_type?: string } | undefined;
  const replyToId = relation?.rel_type === RelationType.Thread ? null : relation?.["m.in_reply_to"]?.event_id ?? null;
  return {
    text: typeof content.body === "string" ? content.body : "",
    formatted: content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" ? content.formatted_body : null,
    edited: Boolean(event.replacingEventId()),
    redacted: false,
    decryptionFailed: false,
    emote: content.msgtype === MsgType.Emote,
    notice: content.msgtype === MsgType.Notice,
    replyToId,
  };
}

/** Local-echo state for the tick/clock/failed indicator. */
export type SendState = "sent" | "sending" | "failed";

export function sendStateOf(event: MatrixEvent): SendState {
  const status = event.status;
  if (status === null || status === undefined) return "sent";
  if (status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED) return "failed";
  return "sending";
}

/** Who has read up to (at least) this event, other than its sender. */
export function readersOf(room: Room, event: MatrixEvent, excludeUserId: string | null): string[] {
  const readers = room.getUsersReadUpTo(event).filter((id) => id !== excludeUserId && id !== event.getSender());
  return readers;
}

/** Can `userId` redact this event? Own messages always; others need power. */
export function canRedact(client: MatrixClient, room: Room, event: MatrixEvent): boolean {
  const me = client.getUserId();
  if (!me) return false;
  if (event.getSender() === me) return true;
  return room.currentState.maySendRedactionForEvent(event, me);
}

export function canEdit(client: MatrixClient, event: MatrixEvent): boolean {
  if (event.getSender() !== client.getUserId()) return false;
  if (event.isRedacted() || event.isDecryptionFailure()) return false;
  const msgtype = event.getContent().msgtype;
  return msgtype === MsgType.Text || msgtype === MsgType.Emote || msgtype === MsgType.Notice;
}

/** Read marker (`m.fully_read`) event id for the room, if any. */
export function readMarkerOf(room: Room): string | null {
  const marker = room.getAccountData(EventType.FullyRead)?.getContent().event_id;
  return typeof marker === "string" ? marker : null;
}

export function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ts));
}

export function formatDayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(d, yesterday)) return "Yesterday";
  const withinWeek = now - ts < 6 * 86_400_000;
  return new Intl.DateTimeFormat(undefined, withinWeek ? { weekday: "long" } : { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" }).format(d);
}
