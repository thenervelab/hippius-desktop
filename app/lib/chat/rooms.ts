/**
 * Room selectors and room-level actions. Framework-agnostic: everything
 * here takes a `MatrixClient` (or a `Room`) and returns plain data, so the
 * React layer only re-renders lists from `summariseRooms()`.
 *
 * Vocabulary: a *channel* is a room that is not a direct message (the
 * `#name` entries), a *DM* is a room listed in the account's `m.direct`
 * map or that looks like one (two members, no name), an *invite* is a room
 * the user has been invited to but not joined.
 */

import {
  type MatrixClient,
  type Room,
  EventType,
  JoinRule,
  KnownMembership,
  NotificationCountType,
  Preset,
  PushRuleActionName,
  PushRuleKind,
  Visibility,
} from "matrix-js-sdk";

export type RoomKind = "channel" | "dm" | "invite";

export interface RoomSummary {
  id: string;
  kind: RoomKind;
  name: string;
  topic: string | null;
  /** Total unread notifications (Matrix `notification_count`). */
  unread: number;
  /** Unread mentions / keywords (Matrix `highlight_count`). */
  highlight: number;
  muted: boolean;
  encrypted: boolean;
  isPublic: boolean;
  memberCount: number;
  /** For DMs: the other party. */
  dmUserId: string | null;
  /** Who invited us, for invites. */
  inviterId: string | null;
  lastActiveTs: number;
  /** `mxc://` avatar, or null. */
  avatarMxc: string | null;
  /** Spaces this room declares as parents (`m.space.parent`), for workspace scoping. */
  spaceParents: string[];
}

export interface RoomBuckets {
  channels: RoomSummary[];
  dms: RoomSummary[];
  invites: RoomSummary[];
}

/** `m.direct` as `{ roomId -> userId }`. */
export function directRoomMap(client: MatrixClient): Map<string, string> {
  const map = new Map<string, string>();
  const content = client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>();
  if (!content) return map;
  for (const [userId, roomIds] of Object.entries(content)) {
    if (!Array.isArray(roomIds)) continue;
    for (const roomId of roomIds) map.set(roomId, userId);
  }
  return map;
}

/** True when the room's push rule says "do not notify". */
export function isRoomMuted(client: MatrixClient, roomId: string): boolean {
  const rule = client.getRoomPushRule("global", roomId);
  if (!rule || !rule.enabled) return false;
  return rule.actions.some((a) => a === PushRuleActionName.DontNotify);
}

function isSpace(room: Room): boolean {
  return room.getType() === "m.space";
}

/** Space ids in the room's `m.space.parent` events that still carry a `via`. */
function spaceParentIds(room: Room): string[] {
  const events = room.currentState.getStateEvents(EventType.SpaceParent);
  if (!Array.isArray(events)) return [];
  const ids: string[] = [];
  for (const event of events) {
    const id = event.getStateKey();
    const via = (event.getContent() as { via?: unknown }).via;
    if (id && Array.isArray(via) && via.length > 0) ids.push(id);
  }
  return ids;
}

function isTombstoned(room: Room): boolean {
  return Boolean(room.currentState.getStateEvents(EventType.RoomTombstone, ""));
}

/** DM partner: `m.direct` first, then a two-person unnamed room. */
export function dmPartnerOf(room: Room, direct: Map<string, string>, myUserId: string): string | null {
  const fromDirect = direct.get(room.roomId);
  if (fromDirect) return fromDirect;
  const inviter = room.getDMInviter();
  if (inviter) return inviter;
  const hasName = Boolean(room.currentState.getStateEvents(EventType.RoomName, "")?.getContent().name);
  if (hasName) return null;
  const joined = room.getJoinedMembers();
  if (room.getJoinedMemberCount() === 2 && joined.length === 2) {
    const other = joined.find((m) => m.userId !== myUserId);
    return other?.userId ?? null;
  }
  return null;
}

export function summariseRoom(
  client: MatrixClient,
  room: Room,
  direct: Map<string, string>,
): RoomSummary | null {
  const myUserId = client.getUserId() ?? "";
  const membership = room.getMyMembership();
  if (membership !== KnownMembership.Join && membership !== KnownMembership.Invite) return null;
  if (isSpace(room) || isTombstoned(room)) return null;

  const dmUserId = dmPartnerOf(room, direct, myUserId);
  const kind: RoomKind =
    membership === KnownMembership.Invite ? "invite" : dmUserId ? "dm" : "channel";

  const topicEvent = room.currentState.getStateEvents(EventType.RoomTopic, "");
  const joinRule = room.getJoinRule();
  const inviter =
    membership === KnownMembership.Invite
      ? room.getMember(myUserId)?.events.member?.getSender() ?? null
      : null;

  let name = room.name;
  if (kind === "dm" && dmUserId) {
    name = room.getMember(dmUserId)?.name ?? client.getUser(dmUserId)?.displayName ?? dmUserId;
  }

  return {
    id: room.roomId,
    kind,
    name,
    topic: (topicEvent?.getContent().topic as string | undefined)?.trim() || null,
    unread: room.getUnreadNotificationCount(NotificationCountType.Total),
    highlight: room.getUnreadNotificationCount(NotificationCountType.Highlight),
    muted: isRoomMuted(client, room.roomId),
    encrypted: room.hasEncryptionStateEvent(),
    isPublic: joinRule === JoinRule.Public,
    memberCount: room.getJoinedMemberCount(),
    dmUserId,
    inviterId: inviter,
    lastActiveTs: room.getLastActiveTimestamp(),
    avatarMxc: room.getMxcAvatarUrl(),
    spaceParents: spaceParentIds(room),
  };
}

function compareChannels(a: RoomSummary, b: RoomSummary): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function compareRecency(a: RoomSummary, b: RoomSummary): number {
  return b.lastActiveTs - a.lastActiveTs;
}

/**
 * Every joined room and invite, split into the sidebar buckets. Channels
 * are alphabetical (Slack), DMs and invites by recency.
 */
export function summariseRooms(client: MatrixClient): RoomBuckets {
  const direct = directRoomMap(client);
  const buckets: RoomBuckets = { channels: [], dms: [], invites: [] };
  for (const room of client.getVisibleRooms()) {
    const summary = summariseRoom(client, room, direct);
    if (!summary) continue;
    if (summary.kind === "invite") buckets.invites.push(summary);
    else if (summary.kind === "dm") buckets.dms.push(summary);
    else buckets.channels.push(summary);
  }
  buckets.channels.sort(compareChannels);
  buckets.dms.sort(compareRecency);
  buckets.invites.sort(compareRecency);
  return buckets;
}

/** Sum of unread notifications across joined rooms that are not muted. */
export function totalUnread(buckets: RoomBuckets): { unread: number; highlight: number } {
  let unread = 0;
  let highlight = 0;
  for (const room of [...buckets.channels, ...buckets.dms]) {
    if (room.muted) continue;
    unread += room.unread;
    highlight += room.highlight;
  }
  return { unread, highlight };
}

/**
 * The number on the dock badge and in the window title: every unread DM
 * message plus the mentions in channels, muted rooms excluded. It is the
 * same set of messages the desktop notifies for (Rust's `decide_notify`:
 * DMs always, channels only on a mention), so the badge never counts a
 * message the app did not consider worth interrupting for — Slack's
 * badge rule. Plain channel unreads stay a sidebar dot.
 */
export function attentionCount(buckets: RoomBuckets): number {
  let count = 0;
  for (const room of buckets.dms) if (!room.muted) count += room.unread;
  for (const room of buckets.channels) if (!room.muted) count += room.highlight;
  return count;
}

/** Slack-style display: `#general` for channels, the person's name for DMs. */
export function roomLabel(summary: Pick<RoomSummary, "kind" | "name">): string {
  return summary.kind === "dm" ? summary.name : `#${summary.name.replace(/^#/, "")}`;
}

/**
 * Channel alias local part from a human name: "Product Design" ->
 * "product-design". Matches what Slack does when creating a channel.
 */
export function slugifyChannelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export interface CreateChannelOptions {
  name: string;
  topic?: string;
  /** Public: anyone on the homeserver can join by alias. Private: invite only. */
  isPublic: boolean;
  /** Invite these user ids on creation. */
  invite?: string[];
}

/**
 * Create a channel. Private channels are encrypted (the homeserver forces
 * E2EE for private rooms anyway); public channels are left unencrypted so
 * newcomers can read history, as Slack public channels do.
 */
export async function createChannel(
  client: MatrixClient,
  options: CreateChannelOptions,
): Promise<string> {
  const slug = slugifyChannelName(options.name);
  const initialState: { type: string; state_key?: string; content: Record<string, unknown> }[] = [];
  if (!options.isPublic) {
    initialState.push({
      type: EventType.RoomEncryption,
      state_key: "",
      content: { algorithm: "m.megolm.v1.aes-sha2" },
    });
  }
  const result = await client.createRoom({
    name: options.name.trim(),
    topic: options.topic?.trim() || undefined,
    preset: options.isPublic ? Preset.PublicChat : Preset.PrivateChat,
    visibility: options.isPublic ? Visibility.Public : Visibility.Private,
    room_alias_name: options.isPublic && slug ? slug : undefined,
    invite: options.invite?.length ? options.invite : undefined,
    initial_state: initialState,
  });
  return result.room_id;
}

/** Existing DM with this user, if the account already has one. */
export function findDirectRoom(client: MatrixClient, userId: string): Room | null {
  const direct = directRoomMap(client);
  for (const [roomId, partner] of direct) {
    if (partner !== userId) continue;
    const room = client.getRoom(roomId);
    if (room && room.getMyMembership() === KnownMembership.Join) return room;
  }
  return null;
}

/**
 * Open (or create) a DM. New DMs are encrypted and recorded in `m.direct`
 * so every client lists them as direct messages.
 */
export async function openDirectRoom(client: MatrixClient, userId: string): Promise<string> {
  const existing = findDirectRoom(client, userId);
  if (existing) return existing.roomId;

  const result = await client.createRoom({
    preset: Preset.TrustedPrivateChat,
    visibility: Visibility.Private,
    is_direct: true,
    invite: [userId],
    initial_state: [
      {
        type: EventType.RoomEncryption,
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ],
  });

  const current =
    client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
  const next: Record<string, string[]> = { ...current };
  next[userId] = [...(next[userId] ?? []), result.room_id];
  await client.setAccountData(EventType.Direct, next);
  return result.room_id;
}

/** Toggle "do not notify" for a room via a room-specific push rule. */
export async function setRoomMuted(
  client: MatrixClient,
  roomId: string,
  muted: boolean,
): Promise<void> {
  if (muted) {
    await client.addPushRule("global", PushRuleKind.RoomSpecific, roomId, {
      actions: [PushRuleActionName.DontNotify],
    });
    return;
  }
  const rule = client.getRoomPushRule("global", roomId);
  if (rule) await client.deletePushRule("global", PushRuleKind.RoomSpecific, rule.rule_id);
}

/** Mark everything in the room as read (read receipt + read marker). */
export async function markRoomRead(client: MatrixClient, room: Room): Promise<void> {
  const events = room.getLiveTimeline().getEvents();
  const last = events[events.length - 1];
  if (!last) return;
  const lastId = last.getId();
  if (!lastId) return;
  await client.setRoomReadMarkers(room.roomId, lastId, last);
}

/** Permalink to a room, matrix.to style, usable in any Matrix client. */
export function roomPermalink(room: Room): string {
  const alias = room.getCanonicalAlias();
  const target = alias ?? room.roomId;
  const via = alias ? "" : `?via=${encodeURIComponent(room.roomId.split(":")[1] ?? "")}`;
  return `https://matrix.to/#/${encodeURIComponent(target)}${via}`;
}

export function eventPermalink(roomId: string, eventId: string): string {
  return `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`;
}

/**
 * The joined room a permalink names, by id or by alias (canonical or
 * alternative), or `null` when this account is not in it. Permalinks copied
 * from the sidebar use the canonical alias when the room has one.
 */
export function findRoomByIdOrAlias(client: MatrixClient, idOrAlias: string): Room | null {
  if (idOrAlias.startsWith("!")) return client.getRoom(idOrAlias);
  if (!idOrAlias.startsWith("#")) return null;
  return (
    client.getRooms().find((room) => room.getCanonicalAlias() === idOrAlias || room.getAltAliases().includes(idOrAlias)) ??
    null
  );
}

/** Who can be picked for a DM or a mention: everyone we share a room with. */
export interface KnownUser {
  userId: string;
  displayName: string;
  avatarMxc: string | null;
}

export function knownUsers(client: MatrixClient): KnownUser[] {
  const me = client.getUserId();
  const seen = new Map<string, KnownUser>();
  for (const room of client.getVisibleRooms()) {
    if (room.getMyMembership() !== KnownMembership.Join) continue;
    for (const member of room.getJoinedMembers()) {
      if (member.userId === me || seen.has(member.userId)) continue;
      seen.set(member.userId, {
        userId: member.userId,
        displayName: member.name,
        avatarMxc: member.getMxcAvatarUrl() ?? null,
      });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );
}

/** Loose `@user:server` check for the invite / DM fields. */
export function isValidUserId(input: string): boolean {
  return /^@[^:\s]+:[^\s]+$/.test(input.trim());
}

/**
 * Turn a typed handle into a full user id on the account's homeserver:
 * "alice" -> "@alice:hippius.com"; full ids pass through.
 */
export function normaliseUserId(input: string, serverName: string): string {
  const trimmed = input.trim();
  if (isValidUserId(trimmed)) return trimmed;
  const local = trimmed.replace(/^@/, "");
  return `@${local}:${serverName}`;
}
