/**
 * Composer back end: send / edit / reply text, upload attachments (encrypting
 * for encrypted rooms), slash commands, typing notices, and per-user, per-room drafts.
 */

import {
  type IContent,
  type MatrixClient,
  type MatrixEvent,
  MsgType,
  RelationType,
  type Room,
} from "matrix-js-sdk";

import { type EncryptedFile, encryptAttachment, msgTypeForMime } from "@/lib/chat/attachments";
import { type MentionTarget, renderMarkdown } from "@/lib/chat/markdown";

// ---------------------------------------------------------------------------
// Text

export interface SendTextOptions {
  mentions?: readonly MentionTarget[];
  /** Thread root to reply in, if any. */
  threadRootId?: string | null;
  /** Quote-reply target (outside or inside a thread). */
  replyTo?: MatrixEvent | null;
  msgtype?: MsgType.Text | MsgType.Emote;
}

function textContent(source: string, opts: SendTextOptions): IContent {
  const rendered = renderMarkdown(source, opts.mentions ?? []);
  const content: IContent = { msgtype: opts.msgtype ?? MsgType.Text, body: rendered.body };
  if (rendered.html) {
    content.format = "org.matrix.custom.html";
    content.formatted_body = rendered.html;
  }
  if (rendered.mentionedUserIds.length || rendered.mentionsRoom) {
    content["m.mentions"] = {
      ...(rendered.mentionedUserIds.length ? { user_ids: rendered.mentionedUserIds } : {}),
      ...(rendered.mentionsRoom ? { room: true } : {}),
    };
  }
  return content;
}

export async function sendText(client: MatrixClient, room: Room, source: string, opts: SendTextOptions = {}): Promise<void> {
  const content = textContent(source, opts);
  const threadId = opts.threadRootId ?? null;
  if (opts.replyTo?.getId()) {
    content["m.relates_to"] = threadId
      ? { rel_type: RelationType.Thread, event_id: threadId, "m.in_reply_to": { event_id: opts.replyTo.getId() }, is_falling_back: false }
      : { "m.in_reply_to": { event_id: opts.replyTo.getId() } };
    const replySender = opts.replyTo.getSender();
    if (replySender) {
      const mentions = (content["m.mentions"] ?? {}) as { user_ids?: string[]; room?: boolean };
      content["m.mentions"] = { ...mentions, user_ids: [...new Set([...(mentions.user_ids ?? []), replySender])] };
    }
  } else if (threadId) {
    const root = room.findEventById(threadId);
    const last = root?.getThread()?.lastReply() ?? root;
    content["m.relates_to"] = {
      rel_type: RelationType.Thread,
      event_id: threadId,
      is_falling_back: true,
      ...(last?.getId() ? { "m.in_reply_to": { event_id: last.getId() } } : {}),
    };
  }
  await client.sendMessage(room.roomId, threadId, content as never);
}

export async function editText(client: MatrixClient, room: Room, target: MatrixEvent, source: string, mentions: readonly MentionTarget[] = []): Promise<void> {
  const targetId = target.getId();
  if (!targetId) throw new Error("Cannot edit an unsent message");
  const inner = textContent(source, { mentions, msgtype: target.getContent().msgtype === MsgType.Emote ? MsgType.Emote : MsgType.Text });
  const content: IContent = {
    ...inner,
    body: `* ${inner.body}`,
    ...(inner.formatted_body ? { formatted_body: `* ${inner.formatted_body}` } : {}),
    "m.new_content": inner,
    "m.relates_to": { rel_type: RelationType.Replace, event_id: targetId },
  };
  await client.sendMessage(room.roomId, target.threadRootId ?? null, content as never);
}

/** Source text to put back in the composer when editing. */
export function editableSource(event: MatrixEvent): string {
  const content = event.getContent();
  return typeof content.body === "string" ? content.body : "";
}

// ---------------------------------------------------------------------------
// Attachments

export interface UploadProgress {
  loaded: number;
  total: number;
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

async function imageDimensions(file: File): Promise<{ w: number; h: number } | null> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(file);
    const dims = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return null;
  }
}

export interface SendFileOptions {
  threadRootId?: string | null;
  onProgress?: (progress: UploadProgress) => void;
  abort?: AbortController;
  /** Event `body` (falls back to the filename). */
  body?: string;
  /** Pixel size when the caller already knows it (skips decoding the file). */
  dimensions?: { w: number; h: number } | null;
  /**
   * Still image to send as `info.thumbnail_file` / `info.thumbnail_url`,
   * encrypted the same way as the file. Callers generate it client-side.
   */
  thumbnail?: File | null;
  /** Extra top-level keys merged into the event content (custom flags). */
  extraContent?: Record<string, unknown>;
}

/**
 * Upload one blob the way the room wants it: AES-CTR encrypted with the
 * filename withheld from the media repo in encrypted rooms, plain
 * otherwise. Returns the pieces the event content needs.
 */
async function uploadForRoom(
  client: MatrixClient,
  encrypted: boolean,
  file: File,
  mimetype: string,
  opts: Pick<SendFileOptions, "onProgress" | "abort">,
): Promise<{ url: string } | { file: EncryptedFile & { mimetype: string } }> {
  if (encrypted) {
    const sealed = await encryptAttachment(await file.arrayBuffer());
    const upload = await client.uploadContent(new Blob([sealed.data]), {
      type: "application/octet-stream",
      includeFilename: false,
      progressHandler: opts.onProgress,
      abortController: opts.abort,
    });
    return { file: { ...sealed.info, url: upload.content_uri, mimetype } };
  }
  const upload = await client.uploadContent(file, { type: mimetype, name: file.name, progressHandler: opts.onProgress, abortController: opts.abort });
  return { url: upload.content_uri };
}

/**
 * Upload one file and send the matching `m.image` / `m.file` / ... event.
 * In encrypted rooms the payload is AES-CTR encrypted before upload and
 * the filename is not sent to the media repo.
 */
export async function sendFile(client: MatrixClient, room: Room, file: File, opts: SendFileOptions = {}): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`Files must be under ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  const encrypted = room.hasEncryptionStateEvent();
  const mimetype = file.type || "application/octet-stream";
  const dims = opts.dimensions === undefined ? await imageDimensions(file) : opts.dimensions;
  const info: Record<string, unknown> = { mimetype, size: file.size, ...(dims ? { w: dims.w, h: dims.h } : {}) };
  const content: IContent = {
    ...opts.extraContent,
    msgtype: msgTypeForMime(mimetype),
    body: opts.body?.trim() || file.name,
    filename: file.name,
    info,
  };

  if (opts.thumbnail) {
    const thumb = opts.thumbnail;
    const thumbMime = thumb.type || "image/jpeg";
    const thumbDims = await imageDimensions(thumb);
    info.thumbnail_info = { mimetype: thumbMime, size: thumb.size, ...(thumbDims ? { w: thumbDims.w, h: thumbDims.h } : {}) };
    const uploaded = await uploadForRoom(client, encrypted, thumb, thumbMime, { abort: opts.abort });
    if ("file" in uploaded) info.thumbnail_file = uploaded.file;
    else info.thumbnail_url = uploaded.url;
  }

  const uploaded = await uploadForRoom(client, encrypted, file, mimetype, opts);
  if ("file" in uploaded) content.file = uploaded.file;
  else content.url = uploaded.url;
  await client.sendMessage(room.roomId, opts.threadRootId ?? null, content as never);
}

// ---------------------------------------------------------------------------
// Typing

/** Debounced typing notices: `true` renews a 20 s notice, `false` clears it. */
export class TypingNotifier {
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = 0;

  private readonly client: MatrixClient;
  private readonly roomId: string;

  constructor(client: MatrixClient, roomId: string) {
    this.client = client;
    this.roomId = roomId;
  }

  typing(): void {
    const now = Date.now();
    if (!this.active || now - this.lastSent > 10_000) {
      this.active = true;
      this.lastSent = now;
      this.client.sendTyping(this.roomId, true, 20_000).catch(() => undefined);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), 5_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.active) return;
    this.active = false;
    this.client.sendTyping(this.roomId, false, 0).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Drafts

const DRAFT_PREFIX = "hippius.chat.draft:";

/**
 * Drafts are keyed by the Matrix user as well as the room, because the
 * webview outlives an account switch: `sessionStorage` is shared by every
 * chat session of the app's lifetime, and two accounts can be members of
 * the same room (a community channel), so a room-only key handed one
 * account's unsent text to the next one to sign in. The user id is hashed
 * only in the sense that it is opaque to a reader; it is the key, not a
 * secret. A composer with no user id (never expected) keeps no draft.
 */
export function draftKey(userId: string, roomId: string, threadRootId?: string | null): string {
  return `${DRAFT_PREFIX}${userId}:${roomId}${threadRootId ? `#${threadRootId}` : ""}`;
}

export function loadDraft(userId: string | null, roomId: string, threadRootId?: string | null): string {
  if (!userId) return "";
  try {
    return sessionStorage.getItem(draftKey(userId, roomId, threadRootId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(userId: string | null, roomId: string, threadRootId: string | null | undefined, text: string): void {
  if (!userId) return;
  try {
    const key = draftKey(userId, roomId, threadRootId);
    if (text.trim()) sessionStorage.setItem(key, text);
    else sessionStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/**
 * Drop every draft `userId` left, in every room and thread. Called when
 * that user signs out of chat, so their unsent text does not wait in the
 * webview for whoever signs in next. Drafts of other users are kept: they
 * are what a user who signs back in expects to find.
 */
export function clearDrafts(userId: string | null): void {
  if (!userId) return;
  const prefix = `${DRAFT_PREFIX}${userId}:`;
  try {
    const stale: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) stale.push(key);
    }
    for (const key of stale) sessionStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

// ---------------------------------------------------------------------------
// Slash commands

export interface SlashCommand {
  name: string;
  args: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "me", args: "<action>", description: "Send an action, e.g. /me waves" },
  { name: "shrug", args: "[message]", description: "Append ¯\\_(ツ)_/¯" },
  { name: "topic", args: "<text>", description: "Set the channel topic" },
  { name: "invite", args: "<@user:server>", description: "Invite someone to this channel" },
  { name: "kick", args: "<@user:server> [reason]", description: "Remove someone from this channel" },
  { name: "leave", args: "", description: "Leave this channel" },
  { name: "join", args: "<#alias or !room>", description: "Join a channel by alias or id" },
  { name: "mute", args: "", description: "Mute this channel" },
  { name: "unmute", args: "", description: "Unmute this channel" },
  { name: "dm", args: "<@user:server>", description: "Open a direct message" },
  { name: "gif", args: "[search]", description: "Find a GIF to send" },
];

export type ParsedInput =
  | { kind: "text"; text: string }
  | { kind: "command"; name: string; args: string }
  | { kind: "unknown-command"; name: string };

/** `/cmd args` -> command; `//text` -> literal text starting with a slash. */
export function parseInput(source: string): ParsedInput {
  if (source.startsWith("//")) return { kind: "text", text: source.slice(1) };
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(source.trim());
  if (!match) return { kind: "text", text: source };
  const name = match[1].toLowerCase();
  if (!SLASH_COMMANDS.some((c) => c.name === name)) return { kind: "unknown-command", name };
  return { kind: "command", name, args: (match[2] ?? "").trim() };
}

export function matchingCommands(prefix: string): SlashCommand[] {
  const q = prefix.replace(/^\//, "").toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

// ---------------------------------------------------------------------------
// Autocomplete triggers

export type Trigger =
  | { kind: "mention"; query: string; start: number }
  | { kind: "emoji"; query: string; start: number }
  | { kind: "command"; query: string; start: number };

/** What autocomplete, if any, applies at the caret. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  if (/^\/[a-z]*$/i.test(before)) return { kind: "command", query: before.slice(1), start: 0 };
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) return { kind: "mention", query: mention[2], start: caret - mention[2].length - 1 };
  const emoji = /(^|\s):([a-z0-9_+-]{2,})$/i.exec(before);
  if (emoji) return { kind: "emoji", query: emoji[2], start: caret - emoji[2].length - 1 };
  return null;
}

/** Replace the trigger token `[start, caret)` with `replacement` + a space. */
export function applyCompletion(text: string, start: number, caret: number, replacement: string): { text: string; caret: number } {
  const next = `${text.slice(0, start)}${replacement} ${text.slice(caret)}`;
  return { text: next, caret: start + replacement.length + 1 };
}
