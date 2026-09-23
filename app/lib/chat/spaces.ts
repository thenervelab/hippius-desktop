/**
 * Workspaces. A workspace is a Matrix Space (a room of type `m.space`)
 * whose children are the workspace's channels. The vocabulary follows
 * Slack: one account, several workspaces; each workspace has its own
 * channels; direct messages are the account's, not a workspace's.
 *
 * Framework-agnostic like `rooms.ts`: everything takes a `MatrixClient`
 * (or a `Room`) and returns plain data or performs the Matrix calls. The
 * React layer groups `summariseRooms()` output with `groupChannelsByWorkspace()`.
 *
 * Ported from the web console's `lib/chat/spaces.ts`. The one difference:
 * the console reads the community Space alias from a constants module; on
 * the desktop the Rust side decides it (`ChatConfig.communitySpaceAlias`),
 * so the functions that need it take it as a parameter. The server name
 * comes from the signed-in client (`client.getDomain()`), never a constant.
 *
 * Membership model (owner decision 2026-09-18): nobody belongs to anything
 * at account creation. You create a workspace (your company) or accept an
 * invitation. `#hippius:hippius.com` is the public community Space that
 * anyone can join; it is one workspace among others, not a default.
 */

import {
  type MatrixClient,
  type Room,
  ClientEvent,
  EventType,
  HistoryVisibility,
  JoinRule,
  KnownMembership,
  NotificationCountType,
  Preset,
  RestrictedAllowType,
  RoomEvent,
  Visibility,
} from "matrix-js-sdk";

import type { RoomSummary } from "@/lib/chat/rooms";

// ------------------------------------------------------------- roles --

export type WorkspaceRole = "owner" | "admin" | "member";

export const ROLE_POWER_LEVEL: Record<WorkspaceRole, number> = {
  owner: 100,
  admin: 50,
  member: 0,
};

export function roleFromPowerLevel(powerLevel: number | undefined): WorkspaceRole {
  if (powerLevel === undefined) return "member";
  if (powerLevel >= ROLE_POWER_LEVEL.owner) return "owner";
  if (powerLevel >= ROLE_POWER_LEVEL.admin) return "admin";
  return "member";
}

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

// ---------------------------------------------------------- summaries --

export interface WorkspaceSummary {
  id: string;
  name: string;
  topic: string | null;
  avatarMxc: string | null;
  memberCount: number;
  myRole: WorkspaceRole;
  /**
   * We may add channels: the Space's power levels let us send
   * `m.space.child`. Creating a room is always allowed; linking it into
   * the workspace is what the Space controls.
   */
  canCreateChannels: boolean;
  /** Anyone on the homeserver may join (the community Space). */
  isPublic: boolean;
  /** This is `#hippius:hippius.com`, the Hippius community. */
  isCommunity: boolean;
  canonicalAlias: string | null;
}

export interface WorkspaceInvite {
  id: string;
  name: string;
  avatarMxc: string | null;
  inviterId: string | null;
}

export interface WorkspaceLists {
  /** Joined Spaces, alphabetical. */
  workspaces: WorkspaceSummary[];
  /** Spaces we have been invited to but not joined. */
  invites: WorkspaceInvite[];
}

export function isSpaceRoom(room: Room): boolean {
  return typeof room.isSpaceRoom === "function" ? room.isSpaceRoom() : room.getType() === "m.space";
}

export function isTombstoned(room: Room): boolean {
  return Boolean(room.currentState.getStateEvents(EventType.RoomTombstone, ""));
}

/**
 * The workspace a category Space belongs to, or null when `room` is a
 * workspace of its own. A category is a Space that a joined Space lists as
 * a child (`m.space.child`, the authoritative side: only workspace admins
 * write it), or that declares a canonical `m.space.parent` to a joined
 * Space (present from the category's first sync, before the parent's link
 * has arrived, so it never flashes up in the rail as a workspace).
 */
export function categoryParentId(client: MatrixClient, room: Room): string | null {
  if (!isSpaceRoom(room)) return null;
  const joinedSpace = (id: string) => {
    const parent = client.getRoom(id);
    return parent && parent.roomId !== room.roomId && isSpaceRoom(parent) && parent.getMyMembership() === KnownMembership.Join ? parent : null;
  };
  for (const event of room.currentState.getStateEvents(EventType.SpaceParent) ?? []) {
    const id = event.getStateKey();
    const content = event.getContent() as { via?: unknown; canonical?: unknown };
    if (id && content.canonical === true && Array.isArray(content.via) && content.via.length > 0 && joinedSpace(id)) return id;
  }
  for (const candidate of client.getVisibleRooms()) {
    if (!joinedSpace(candidate.roomId)) continue;
    const link = candidate.currentState.getStateEvents(EventType.SpaceChild, room.roomId);
    const via = (link?.getContent() as { via?: unknown } | undefined)?.via;
    if (Array.isArray(via) && via.length > 0) return candidate.roomId;
  }
  return null;
}

/**
 * @param communitySpaceAlias The public community Space's canonical alias
 *   (`ChatConfig.communitySpaceAlias`); marks that one workspace `isCommunity`.
 */
export function summariseWorkspace(client: MatrixClient, room: Room, communitySpaceAlias: string): WorkspaceSummary {
  const me = client.getUserId() ?? "";
  const alias = room.getCanonicalAlias();
  const topicEvent = room.currentState.getStateEvents(EventType.RoomTopic, "");
  return {
    id: room.roomId,
    name: room.name,
    topic: (topicEvent?.getContent().topic as string | undefined)?.trim() || null,
    avatarMxc: room.getMxcAvatarUrl(),
    memberCount: room.getJoinedMemberCount(),
    myRole: roleFromPowerLevel(room.getMember(me)?.powerLevel),
    canCreateChannels: canCreateChannels(room, me),
    isPublic: room.getJoinRule() === JoinRule.Public,
    isCommunity: alias !== null && alias === communitySpaceAlias,
    canonicalAlias: alias,
  };
}

/** Whether `userId` may link a new channel into the Space. */
export function canCreateChannels(space: Room, userId: string): boolean {
  return space.currentState.maySendStateEvent(EventType.SpaceChild, userId);
}

function compareByName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Every Space the account is in or invited to, except the category Spaces
 * inside a joined workspace (they are that workspace's, not one of their
 * own) and closed (tombstoned) Spaces.
 */
export function listWorkspaces(client: MatrixClient, communitySpaceAlias: string): WorkspaceLists {
  const me = client.getUserId() ?? "";
  const workspaces: WorkspaceSummary[] = [];
  const invites: WorkspaceInvite[] = [];
  for (const room of client.getVisibleRooms()) {
    if (!isSpaceRoom(room) || isTombstoned(room) || categoryParentId(client, room)) continue;
    const membership = room.getMyMembership();
    if (membership === KnownMembership.Join) {
      workspaces.push(summariseWorkspace(client, room, communitySpaceAlias));
    } else if (membership === KnownMembership.Invite) {
      invites.push({
        id: room.roomId,
        name: room.name,
        avatarMxc: room.getMxcAvatarUrl(),
        inviterId: room.getMember(me)?.events.member?.getSender() ?? null,
      });
    }
  }
  workspaces.sort(compareByName);
  invites.sort(compareByName);
  return { workspaces, invites };
}

// ----------------------------------------------------------- children --

export interface SpaceChild {
  roomId: string;
  /** `m.space.child` `order`, when set. */
  order: string | null;
  suggested: boolean;
  via: string[];
}

/**
 * The Space's child links in display order: suggested first (the default
 * channels), then by `order` (lexicographic, as the spec says), then by
 * name for children without an order. Links whose content was emptied
 * (the spec's way of removing a child) are dropped.
 */
 
export function spaceChildren(space: Room, nameOf: (roomId: string) => string): SpaceChild[] {
  const events = space.currentState.getStateEvents(EventType.SpaceChild) ?? [];
  const children: SpaceChild[] = [];
  for (const event of events) {
    const roomId = event.getStateKey();
    if (!roomId) continue;
    const content = event.getContent() as { via?: unknown; order?: unknown; suggested?: unknown };
    const via = Array.isArray(content.via) ? content.via.filter((v): v is string => typeof v === "string") : [];
    if (via.length === 0) continue; // removed link
    children.push({
      roomId,
      order: typeof content.order === "string" ? content.order : null,
      suggested: content.suggested === true,
      via,
    });
  }
  return sortSpaceChildren(children, nameOf);
}

 
function sortSpaceChildren(children: SpaceChild[], nameOf: (roomId: string) => string): SpaceChild[] {
  children.sort((a, b) => {
    if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
    if (a.order !== null && b.order !== null && a.order !== b.order) return a.order < b.order ? -1 : 1;
    if (a.order !== null && b.order === null) return -1;
    if (a.order === null && b.order !== null) return 1;
    return nameOf(a.roomId).localeCompare(nameOf(b.roomId), undefined, { sensitivity: "base" });
  });
  return children;
}

/** `order` for the n-th channel: fixed width so string sort equals numeric sort. */
export function channelOrderKey(index: number): string {
  return String(index).padStart(6, "0");
}

/** `order` that sorts after every child `space` has today. */
export function nextChildOrderKey(space: Room): string {
  return channelOrderKey(spaceChildren(space, (id) => id).length);
}

// --------------------------------------------------------- categories --

/**
 * A channel category, Slack/Discord style: a child Space of the workspace
 * whose own children are the channels in the category. Uncategorised
 * channels stay direct children of the workspace. Categories are pure
 * grouping: a channel's join rule keeps pointing at the workspace, and
 * membership of the category Space is automatic for workspace members.
 */
export interface WorkspaceCategory {
  id: string;
  name: string;
  /** `m.space.child` `order` in the workspace. */
  order: string | null;
  /** The category Space as synced, when we are in it. */
  room: Room | null;
  /** Channel links in the category's own order; empty until the category is joined. */
  children: SpaceChild[];
}

export interface WorkspaceTree {
  /** Channel links directly under the workspace, in order. */
  uncategorised: SpaceChild[];
  /** In workspace order. */
  categories: WorkspaceCategory[];
  /** Channel id -> the Space that links it (the workspace or a category). */
  containerOf: Map<string, string>;
}

/**
 * Whether the child `roomId` of a workspace is a category. Only a synced
 * Space can be recognised; a child we are not in is treated as a channel
 * link (it has no local room, so nothing displays it either way) until the
 * auto-join catches up.
 */
function categoryRoomOf(client: MatrixClient, roomId: string): Room | null {
  const room = client.getRoom(roomId);
  return room && isSpaceRoom(room) && !isTombstoned(room) ? room : null;
}

/** The workspace's children split into categories and uncategorised channels. */
export function workspaceTree(client: MatrixClient, space: Room): WorkspaceTree {
  const nameOf = (roomId: string) => client.getRoom(roomId)?.name ?? roomId;
  const uncategorised: SpaceChild[] = [];
  const categories: WorkspaceCategory[] = [];
  const containerOf = new Map<string, string>();
  for (const link of spaceChildren(space, nameOf)) {
    const room = categoryRoomOf(client, link.roomId);
    if (!room) {
      uncategorised.push(link);
      containerOf.set(link.roomId, space.roomId);
      continue;
    }
    const children = room.getMyMembership() === KnownMembership.Join ? spaceChildren(room, nameOf) : [];
    for (const child of children) {
      // A channel linked from two places belongs to the first that lists it.
      if (!containerOf.has(child.roomId)) containerOf.set(child.roomId, room.roomId);
    }
    categories.push({ id: room.roomId, name: room.name, order: link.order, room, children });
  }
  return { uncategorised, categories, containerOf };
}

/** Every channel link of the workspace: its own, then each category's. */
export function allChannelLinks(client: MatrixClient, space: Room): SpaceChild[] {
  const tree = workspaceTree(client, space);
  return [...tree.uncategorised, ...tree.categories.flatMap((c) => c.children)];
}

export interface CategoryChannels {
  id: string;
  name: string;
  channels: RoomSummary[];
}

export interface WorkspaceChannelGroups {
  /** Joined channels linked directly to the workspace, in order. */
  uncategorised: RoomSummary[];
  /** In workspace order, including empty categories. */
  categories: CategoryChannels[];
}

export interface GroupedChannels {
  /** Space id -> every channel of the workspace (uncategorised first, then category by category). */
  byWorkspace: Map<string, RoomSummary[]>;
  /** Space id -> the same channels split by category, for the sidebar. */
  groupsByWorkspace: Map<string, WorkspaceChannelGroups>;
  /** Joined channels that belong to no Space we are in. */
  orphans: RoomSummary[];
}

/**
 * Scope the flat channel list to workspaces. A channel belongs to a Space
 * when the Space (or one of its categories) links to it (`m.space.child`)
 * or, failing that, when the channel points at the Space or a category
 * (`m.space.parent`). A channel with neither is an orphan (pre-workspace
 * rooms, or rooms shared from elsewhere).
 */
export function groupChannelsByWorkspace(client: MatrixClient, channels: readonly RoomSummary[]): GroupedChannels {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const byWorkspace = new Map<string, RoomSummary[]>();
  const groupsByWorkspace = new Map<string, WorkspaceChannelGroups>();
  const claimed = new Set<string>();
  /** Workspace or category id -> the workspace it belongs to (for the parent fallback). */
  const workspaceOf = new Map<string, string>();
  /** Category id -> its bucket, for the fallback to land a channel in the right one. */
  const categoryBucket = new Map<string, CategoryChannels>();

  const spaces = client
    .getVisibleRooms()
    .filter((room) => isSpaceRoom(room) && !isTombstoned(room) && room.getMyMembership() === KnownMembership.Join && !categoryParentId(client, room))
    .sort(compareByName);

  const take = (link: SpaceChild): RoomSummary | null => {
    const summary = byId.get(link.roomId);
    if (!summary || claimed.has(summary.id)) return null;
    claimed.add(summary.id);
    return summary;
  };

  for (const space of spaces) {
    const tree = workspaceTree(client, space);
    const groups: WorkspaceChannelGroups = { uncategorised: [], categories: [] };
    workspaceOf.set(space.roomId, space.roomId);
    for (const link of tree.uncategorised) {
      const summary = take(link);
      if (summary) groups.uncategorised.push(summary);
    }
    for (const category of tree.categories) {
      const bucket: CategoryChannels = { id: category.id, name: category.name, channels: [] };
      for (const link of category.children) {
        const summary = take(link);
        if (summary) bucket.channels.push(summary);
      }
      groups.categories.push(bucket);
      categoryBucket.set(category.id, bucket);
      workspaceOf.set(category.id, space.roomId);
    }
    groupsByWorkspace.set(space.roomId, groups);
  }

  const orphans: RoomSummary[] = [];
  for (const summary of channels) {
    if (claimed.has(summary.id)) continue;
    const parent = summary.spaceParents.find((id) => workspaceOf.has(id));
    if (parent) {
      claimed.add(summary.id);
      const bucket = categoryBucket.get(parent);
      if (bucket) bucket.channels.push(summary);
      else groupsByWorkspace.get(parent)!.uncategorised.push(summary);
    } else {
      orphans.push(summary);
    }
  }

  for (const [spaceId, groups] of groupsByWorkspace) {
    byWorkspace.set(spaceId, [...groups.uncategorised, ...groups.categories.flatMap((c) => c.channels)]);
  }
  return { byWorkspace, groupsByWorkspace, orphans };
}

export interface WorkspaceBadge {
  unread: number;
  highlight: number;
}

/** Rail badges: unread and mentions per workspace, muted channels excluded. */
export function workspaceBadges(byWorkspace: ReadonlyMap<string, readonly RoomSummary[]>): Map<string, WorkspaceBadge> {
  const badges = new Map<string, WorkspaceBadge>();
  for (const [spaceId, channels] of byWorkspace) {
    let unread = 0;
    let highlight = 0;
    for (const room of channels) {
      if (room.muted) continue;
      unread += room.unread;
      highlight += room.highlight;
    }
    badges.set(spaceId, { unread, highlight });
  }
  return badges;
}

/** Invites to rooms inside this Space (the Space's own invite is handled by the rail). */
export function workspaceUnreadFromRoom(room: Room): WorkspaceBadge {
  return {
    unread: room.getUnreadNotificationCount(NotificationCountType.Total),
    highlight: room.getUnreadNotificationCount(NotificationCountType.Highlight),
  };
}

// --------------------------------------------------------- creation --

/**
 * The signed-in account's server, used as the `via` of every Space link.
 * The client always has a user id once signed in, so the domain is known;
 * the throw guards against a call before sign-in rather than inventing one.
 */
function serverName(client: MatrixClient): string {
  const domain = client.getDomain();
  if (!domain) throw new Error("Chat client has no user id yet");
  return domain;
}

/** The `allow` list that restricts a channel to members of its Space. */
export const CHANNEL_JOIN_RULE_ALLOW = (spaceId: string) => [{ type: RestrictedAllowType.RoomMembership, room_id: spaceId }];

export interface WorkspaceChannelSpec {
  name: string;
  topic?: string;
  /** Default channels are `suggested` in the Space and every invitee is invited to them. */
  isDefault: boolean;
}

export interface CreateWorkspaceOptions {
  name: string;
  topic?: string;
  avatarMxc?: string | null;
  channels: WorkspaceChannelSpec[];
}

export interface CreateWorkspaceResult {
  spaceId: string;
  /** Same order as `options.channels`. */
  channelIds: string[];
}

/** Progress callback for the multi-step creation, for the dialog's status line. */
 
export type CreateWorkspaceProgress = (step: { done: number; total: number; label: string }) => void;

interface InitialStateEvent {
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
}

/**
 * Power levels of a workspace channel. The Space decides who is in the
 * workspace; a channel must not offer a way around that. Matrix lets an
 * explicitly invited user join a restricted room without meeting its
 * `allow` condition, and the SDK's `PublicChat` preset leaves `invite` at
 * 0 — so an ordinary member could invite an outsider who would then read
 * the shared history. Inviting, kicking, banning, redacting and changing
 * room state are therefore admin actions (50), the same as on the Space;
 * talking stays open to everyone (0).
 */
export function workspaceChannelPowerLevels(creator: string) {
  return {
    users: { [creator]: ROLE_POWER_LEVEL.owner },
    users_default: ROLE_POWER_LEVEL.member,
    invite: ROLE_POWER_LEVEL.admin,
    kick: ROLE_POWER_LEVEL.admin,
    ban: ROLE_POWER_LEVEL.admin,
    redact: ROLE_POWER_LEVEL.admin,
    state_default: ROLE_POWER_LEVEL.admin,
    events_default: ROLE_POWER_LEVEL.member,
    events: {
      [EventType.RoomName]: ROLE_POWER_LEVEL.admin,
      [EventType.RoomAvatar]: ROLE_POWER_LEVEL.admin,
      [EventType.RoomTopic]: ROLE_POWER_LEVEL.admin,
      [EventType.RoomJoinRules]: ROLE_POWER_LEVEL.admin,
      [EventType.RoomHistoryVisibility]: ROLE_POWER_LEVEL.owner,
      [EventType.SpaceParent]: ROLE_POWER_LEVEL.admin,
      [EventType.RoomPowerLevels]: ROLE_POWER_LEVEL.owner,
      [EventType.RoomTombstone]: ROLE_POWER_LEVEL.owner,
    },
  };
}

/**
 * `createRoom` options for a channel inside `spaceId`: private (not in the
 * public directory), join rule restricted to the Space's members, history
 * visible to everyone who joins, canonical parent link, admin-only invites
 * (`workspaceChannelPowerLevels`). Not end-to-end encrypted: a restricted
 * channel is the workspace's equivalent of a Slack public channel, and
 * whoever joins later must be able to read what was said.
 *
 * `parentId` is the Space that will list the channel — a category, when
 * the channel is created in one. The join rule still names the workspace:
 * who may enter a channel is the workspace's decision, a category only
 * groups.
 */
export function workspaceChannelCreateOptions(
  client: MatrixClient,
  spaceId: string,
  spec: { name: string; topic?: string },
  extraInvite?: string[],
  parentId: string = spaceId,
) {
  const via = [serverName(client)];
  const me = client.getUserId() ?? "";
  const initialState: InitialStateEvent[] = [
    {
      type: EventType.RoomJoinRules,
      state_key: "",
      content: { join_rule: JoinRule.Restricted, allow: CHANNEL_JOIN_RULE_ALLOW(spaceId) },
    },
    {
      type: EventType.RoomHistoryVisibility,
      state_key: "",
      content: { history_visibility: HistoryVisibility.Shared },
    },
    {
      type: EventType.SpaceParent,
      state_key: parentId,
      content: { via, canonical: true },
    },
  ];
  return {
    name: spec.name.trim(),
    topic: spec.topic?.trim() || undefined,
    // PublicChat gives shared history and no forced encryption; the join
    // rule above overrides its `public` join rule.
    preset: Preset.PublicChat,
    visibility: Visibility.Private,
    power_level_content_override: workspaceChannelPowerLevels(me),
    invite: extraInvite?.length ? extraInvite : undefined,
    initial_state: initialState,
  };
}

/** Link `roomId` as a child of `spaceId`. */
export async function linkChannel(
  client: MatrixClient,
  spaceId: string,
  roomId: string,
  opts: { suggested: boolean; order: string },
): Promise<void> {
  await client.sendStateEvent(
    spaceId,
    EventType.SpaceChild,
    { via: [serverName(client)], suggested: opts.suggested, order: opts.order },
    roomId,
  );
}

/**
 * Create a workspace: the Space, one restricted channel per entry, and the
 * child links (default channels `suggested`). If any step fails, everything
 * created so far is left (the creator is its only member, so leaving
 * abandons it) and the error is rethrown: no half-workspace survives.
 */
export async function createWorkspace(
  client: MatrixClient,
  options: CreateWorkspaceOptions,
  onProgress?: CreateWorkspaceProgress,
): Promise<CreateWorkspaceResult> {
  const me = client.getUserId() ?? "";
  const total = 1 + options.channels.length * 2;
  let done = 0;
  const progress = (label: string) => onProgress?.({ done: done++, total, label });
  const created: string[] = [];

  try {
    progress(`Creating ${options.name}`);
    const spaceInitialState: InitialStateEvent[] = [];
    if (options.avatarMxc) {
      spaceInitialState.push({ type: EventType.RoomAvatar, state_key: "", content: { url: options.avatarMxc } });
    }
    const space = await client.createRoom({
      name: options.name.trim(),
      topic: options.topic?.trim() || undefined,
      preset: Preset.PrivateChat,
      visibility: Visibility.Private,
      creation_content: { type: "m.space" },
      power_level_content_override: {
        users: { [me]: ROLE_POWER_LEVEL.owner },
        users_default: ROLE_POWER_LEVEL.member,
        invite: ROLE_POWER_LEVEL.admin,
        kick: ROLE_POWER_LEVEL.admin,
        ban: ROLE_POWER_LEVEL.admin,
        redact: ROLE_POWER_LEVEL.admin,
        state_default: ROLE_POWER_LEVEL.admin,
        events_default: ROLE_POWER_LEVEL.member,
        events: {
          [EventType.RoomName]: ROLE_POWER_LEVEL.admin,
          [EventType.RoomAvatar]: ROLE_POWER_LEVEL.admin,
          [EventType.RoomTopic]: ROLE_POWER_LEVEL.admin,
          [EventType.SpaceChild]: ROLE_POWER_LEVEL.admin,
          [EventType.RoomPowerLevels]: ROLE_POWER_LEVEL.owner,
          [EventType.RoomTombstone]: ROLE_POWER_LEVEL.owner,
        },
      },
      initial_state: spaceInitialState,
    });
    const spaceId = space.room_id;
    created.push(spaceId);

    const channelIds: string[] = [];
    for (const spec of options.channels) {
      progress(`Creating #${spec.name}`);
      const room = await client.createRoom(workspaceChannelCreateOptions(client, spaceId, spec));
      created.push(room.room_id);
      channelIds.push(room.room_id);
    }
    for (const [index, spec] of options.channels.entries()) {
      progress(`Adding #${spec.name} to ${options.name}`);
      await linkChannel(client, spaceId, channelIds[index], { suggested: spec.isDefault, order: channelOrderKey(index) });
    }
    onProgress?.({ done: total, total, label: "Done" });
    return { spaceId, channelIds };
  } catch (error) {
    // Reverse order: channels first, the space last.
    for (const roomId of [...created].reverse()) {
      try {
        await client.leave(roomId);
      } catch {
        // Best effort. An abandoned single-member room is harmless.
      }
    }
    throw error;
  }
}

/**
 * Add a channel to an existing workspace: restricted room + child link.
 * Checked against the Space's power levels first, since anyone can create
 * a room but only the Space decides who may link one in; if the link still
 * fails, the room we just made is left rather than abandoned as an orphan
 * nobody can find. With `categoryId` the link (and the channel's canonical
 * parent) go to that category instead of the workspace; the join rule
 * names the workspace either way.
 */
export async function createWorkspaceChannel(
  client: MatrixClient,
  spaceId: string,
  spec: { name: string; topic?: string; isDefault?: boolean; order: string; categoryId?: string | null },
): Promise<string> {
  const space = client.getRoom(spaceId);
  if (space && !canCreateChannels(space, client.getUserId() ?? "")) {
    throw new Error(`You cannot add channels to ${space.name}. Ask an admin or owner.`);
  }
  const containerId = spec.categoryId ?? spaceId;
  const container = client.getRoom(containerId);
  if (containerId !== spaceId && container && !canCreateChannels(container, client.getUserId() ?? "")) {
    throw new Error(`You cannot add channels to the ${container.name} category. Ask an admin or owner.`);
  }
  const room = await client.createRoom(workspaceChannelCreateOptions(client, spaceId, spec, undefined, containerId));
  try {
    await linkChannel(client, containerId, room.room_id, { suggested: spec.isDefault ?? false, order: spec.order });
  } catch (error) {
    try {
      await client.leave(room.room_id);
    } catch {
      // Best effort: the room stays, empty, as a leftover of a failed step.
    }
    throw new Error(`Could not add #${spec.name} to the workspace: ${messageOf(error)}`);
  }
  return room.room_id;
}

// ------------------------------------------------------- discoverable --

export interface JoinableChannel {
  roomId: string;
  name: string;
  topic: string | null;
  memberCount: number;
  /** A default channel of the workspace. */
  suggested: boolean;
  /** Servers to join through (`m.space.child` `via`). */
  via: string[];
  /** The category listing the channel; null for an uncategorised one. */
  categoryId: string | null;
  categoryName: string | null;
}

export interface JoinableCategory {
  roomId: string;
  name: string;
  via: string[];
}

export interface WorkspaceHierarchy {
  channels: JoinableChannel[];
  /** Category Spaces of the workspace we are not in yet (to auto-join). */
  categories: JoinableCategory[];
}

/** A hierarchy room's `children_state` as `SpaceChild`s, in display order. */
 
function hierarchyChildren(links: readonly { state_key?: string; content: unknown }[] | undefined, nameOf: (roomId: string) => string): SpaceChild[] {
  const children: SpaceChild[] = [];
  for (const link of links ?? []) {
    const content = link.content as { via?: unknown; order?: unknown; suggested?: unknown };
    const via = Array.isArray(content.via) ? content.via.filter((v): v is string => typeof v === "string") : [];
    if (!link.state_key || via.length === 0) continue;
    children.push({
      roomId: link.state_key,
      order: typeof content.order === "string" ? content.order : null,
      suggested: content.suggested === true,
      via,
    });
  }
  return sortSpaceChildren(children, nameOf);
}

/**
 * Channels of the Space we could join but have not: `/hierarchy` two
 * levels deep, which lists the children the server lets us see (for a
 * restricted child of a Space we are in, that is all of them) — the
 * workspace's own and those of its categories — minus what we are already
 * in or banned from. The local room list only knows rooms we are in, so
 * without this a channel someone else created never shows up. Order
 * follows the `m.space.child` order of each container, uncategorised
 * first, then category by category in workspace order. Category Spaces we
 * are not in yet are returned apart, for the caller to join.
 */
type HierarchyRoom = Awaited<ReturnType<MatrixClient["getRoomHierarchy"]>>["rooms"][number];

/** `/hierarchy` of `spaceId`, every page, `depth` levels down. */
async function fetchHierarchyRooms(client: MatrixClient, spaceId: string, depth: number): Promise<Map<string, HierarchyRoom>> {
  const rooms = new Map<string, HierarchyRoom>();
  let from: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await client.getRoomHierarchy(spaceId, 100, depth, false, from);
    for (const room of result.rooms) rooms.set(room.room_id, room);
    from = result.next_batch;
    if (!from) break;
  }
  return rooms;
}

export async function fetchWorkspaceHierarchy(client: MatrixClient, space: Room): Promise<WorkspaceHierarchy> {
  const nameOf = (id: string) => client.getRoom(id)?.name ?? id;
  const byId = await fetchHierarchyRooms(client, space.roomId, 2);
  const root = byId.get(space.roomId);
  const rootChildren = root?.children_state?.length ? hierarchyChildren(root.children_state, nameOf) : spaceChildren(space, nameOf);
  const seen = new Set<string>();

  const channels: JoinableChannel[] = [];
  const categories: JoinableCategory[] = [];
  const skip = (roomId: string) => {
    const membership = client.getRoom(roomId)?.getMyMembership();
    return membership === KnownMembership.Join || membership === KnownMembership.Invite || membership === KnownMembership.Ban;
  };
  const push = (link: SpaceChild, category: { id: string; name: string } | null) => {
    seen.add(link.roomId);
    const room = byId.get(link.roomId);
    if (!room || room.room_type === "m.space" || skip(link.roomId)) return;
    channels.push({
      roomId: room.room_id,
      name: room.name?.trim() || room.canonical_alias?.replace(/^#/, "").replace(/:.*$/, "") || room.room_id,
      topic: room.topic?.trim() || null,
      memberCount: room.num_joined_members,
      suggested: link.suggested,
      via: link.via,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
    });
  };

  const categoryLinks: SpaceChild[] = [];
  for (const link of rootChildren) {
    if (byId.get(link.roomId)?.room_type === "m.space") categoryLinks.push(link);
    else push(link, null);
  }
  for (const link of categoryLinks) {
    const category = byId.get(link.roomId)!;
    const name = category.name?.trim() || link.roomId;
    if (client.getRoom(link.roomId)?.getMyMembership() !== KnownMembership.Join) {
      categories.push({ roomId: link.roomId, name, via: link.via });
    }
    for (const child of hierarchyChildren(category.children_state, nameOf)) push(child, { id: link.roomId, name });
  }
  // Rooms the server reaches through a link we do not have yet (local state
  // behind): listed last, uncategorised, by name.
  const strays = [...byId.values()]
    .filter((room) => room.room_id !== space.roomId && room.room_type !== "m.space" && !seen.has(room.room_id))
    .sort((a, b) => compareByName({ name: a.name ?? a.room_id }, { name: b.name ?? b.room_id }));
  for (const room of strays) push({ roomId: room.room_id, order: null, suggested: false, via: [serverName(client)] }, null);
  return { channels, categories };
}

/** `fetchWorkspaceHierarchy` for callers that only want the channels. */
export async function fetchJoinableChannels(client: MatrixClient, space: Room): Promise<JoinableChannel[]> {
  return (await fetchWorkspaceHierarchy(client, space)).channels;
}

/** Room ids of the default (suggested) channels of a workspace, in its categories too. */
export function defaultChannelIds(client: MatrixClient, space: Room): string[] {
  return allChannelLinks(client, space)
    .filter((c) => c.suggested)
    .map((c) => c.roomId);
}

// ---------------------------------------------------------- invites --

export interface InviteOutcome {
  invited: string[];
  failed: { userId: string; message: string }[];
}

/**
 * Invite people to the workspace: the Space itself, then each default
 * channel. The Space invite is the one that matters (it unlocks every
 * restricted channel); a channel invite that fails (already there, or
 * we lack the power) does not fail the person.
 */
export async function inviteToWorkspace(
  client: MatrixClient,
  spaceId: string,
  userIds: readonly string[],
  defaultChannels: readonly string[],
): Promise<InviteOutcome> {
  const outcome: InviteOutcome = { invited: [], failed: [] };
  for (const userId of userIds) {
    try {
      await client.invite(spaceId, userId);
    } catch (error) {
      outcome.failed.push({ userId, message: error instanceof Error ? error.message : "Could not invite" });
      continue;
    }
    for (const roomId of defaultChannels) {
      try {
        await client.invite(roomId, userId);
      } catch {
        // Tolerated: see above.
      }
    }
    outcome.invited.push(userId);
  }
  return outcome;
}

/**
 * The workspace's channel links (its own and its categories') and its
 * category links, as the server has them right now. `joinRoom` resolves
 * when the join request does, before sync delivers the room, so the local
 * Space is empty or absent at that point; `/hierarchy` returns the
 * `m.space.child` state without waiting on sync. Falls back to whatever
 * local state exists if the endpoint is unavailable.
 */
async function serverWorkspaceLinks(client: MatrixClient, spaceId: string): Promise<{ channels: SpaceChild[]; categories: SpaceChild[] }> {
  const nameOf = (id: string) => id;
  try {
    const byId = await fetchHierarchyRooms(client, spaceId, 2);
    const root = byId.get(spaceId);
    const channels: SpaceChild[] = [];
    const categories: SpaceChild[] = [];
    for (const link of hierarchyChildren(root?.children_state, nameOf)) {
      const room = byId.get(link.roomId);
      if (room?.room_type === "m.space") {
        categories.push(link);
        channels.push(...hierarchyChildren(room.children_state, nameOf).filter((c) => byId.get(c.roomId)?.room_type !== "m.space"));
      } else {
        channels.push(link);
      }
    }
    return { channels, categories };
  } catch {
    const space = client.getRoom(spaceId);
    if (!space) return { channels: [], categories: [] };
    const tree = workspaceTree(client, space);
    return {
      channels: [...tree.uncategorised, ...tree.categories.flatMap((c) => c.children)],
      categories: tree.categories.map((c) => ({ roomId: c.id, order: c.order, suggested: false, via: [serverName(client)] })),
    };
  }
}

/** Join every category Space of the workspace we are not in yet. Best effort each. */
async function joinCategories(client: MatrixClient, categories: readonly SpaceChild[]): Promise<void> {
  for (const category of categories) {
    const membership = client.getRoom(category.roomId)?.getMyMembership();
    if (membership === KnownMembership.Join || membership === KnownMembership.Ban) continue;
    try {
      await client.joinRoom(category.roomId, { viaServers: category.via });
    } catch {
      // Its channels still join through the workspace; the grouping catches up when we get in.
    }
  }
}

/**
 * Categories added to the workspace since we joined it: the workspace's
 * `m.space.child` links we have no local room for are asked of the server
 * (one `/hierarchy` call, depth 1) and the Spaces among them joined, so the
 * sidebar can group by them. Returns the number of categories joined.
 */
export async function joinNewCategories(client: MatrixClient, space: Room): Promise<number> {
  const unknown: SpaceChild[] = [];
  const invited: SpaceChild[] = [];
  for (const link of spaceChildren(space, (id) => id)) {
    const room = client.getRoom(link.roomId);
    if (!room) unknown.push(link);
    else if (isSpaceRoom(room) && room.getMyMembership() === KnownMembership.Invite) invited.push(link);
  }
  const categories = [...invited];
  if (unknown.length > 0) {
    const byId = await fetchHierarchyRooms(client, space.roomId, 1);
    categories.push(...unknown.filter((link) => byId.get(link.roomId)?.room_type === "m.space"));
  }
  await joinCategories(client, categories);
  return categories.length;
}

/** Join the workspace's categories, then its channels (`joinSpaceChannels`). */
async function joinWorkspaceTree(client: MatrixClient, spaceId: string): Promise<void> {
  const links = await serverWorkspaceLinks(client, spaceId);
  await joinCategories(client, links.categories);
  await joinSpaceChannels(client, spaceId, links.channels);
}

/**
 * After joining a Space: accept every pending invite to one of its children
 * and join its default (suggested) channels. Best effort per channel; the
 * Space is joined, a channel can be joined from the list later.
 */
async function joinSpaceChannels(client: MatrixClient, spaceId: string, children: readonly SpaceChild[]): Promise<void> {
  const me = client.getUserId() ?? "";
  const childIds = new Set(children.map((c) => c.roomId));
  const space = client.getRoom(spaceId);
  const categoryIds = new Set(space ? workspaceTree(client, space).categories.map((c) => c.id) : []);
  const joined = new Set<string>();
  for (const room of client.getVisibleRooms()) {
    if (room.getMyMembership() !== KnownMembership.Invite) continue;
    const linked = childIds.has(room.roomId) || roomParentIds(room).some((id) => id === spaceId || categoryIds.has(id));
    if (!linked) continue;
    try {
      await client.joinRoom(room.roomId);
      joined.add(room.roomId);
    } catch {
      // A stuck channel invite stays in the sidebar.
    }
  }
  for (const child of children) {
    if (!child.suggested || joined.has(child.roomId)) continue;
    const membership = client.getRoom(child.roomId)?.getMember(me)?.membership;
    if (membership === KnownMembership.Join || membership === KnownMembership.Ban) continue;
    try {
      await client.joinRoom(child.roomId, { viaServers: child.via });
    } catch {
      // Optional; the channel can be joined from the list later.
    }
  }
}

/**
 * Resolve once sync has delivered `roomId` with us joined, or after
 * `timeoutMs`. `joinRoom` resolves when the request does; the room list,
 * and anything derived from it, only knows the room once sync catches up.
 * Handing over to a screen that reconciles against the room list before
 * then makes it pick something else.
 */
export function waitForJoinedRoom(client: MatrixClient, roomId: string, timeoutMs = 10_000): Promise<boolean> {
  const joined = () => client.getRoom(roomId)?.getMyMembership() === KnownMembership.Join;
  if (joined()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const check = () => {
      if (!joined()) return;
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      client.off(ClientEvent.Room, check);
      client.off(RoomEvent.MyMembership, check);
    };
    client.on(ClientEvent.Room, check);
    client.on(RoomEvent.MyMembership, check);
  });
}

/** Accept a Space invite, its pending channel invites and its default channels. */
export async function acceptWorkspaceInvite(client: MatrixClient, spaceId: string): Promise<void> {
  await client.joinRoom(spaceId);
  await joinWorkspaceTree(client, spaceId);
}

/** Space ids a room declares as parents (`m.space.parent`). */
export function roomParentIds(room: Room): string[] {
  const events = room.currentState.getStateEvents(EventType.SpaceParent) ?? [];
  const ids: string[] = [];
  for (const event of events) {
    const id = event.getStateKey();
    const via = (event.getContent() as { via?: unknown }).via;
    if (id && Array.isArray(via) && via.length > 0) ids.push(id);
  }
  return ids;
}

/** Join the public Hippius community Space (and its suggested channels). */
export async function joinCommunity(client: MatrixClient, communitySpaceAlias: string): Promise<string> {
  const room = await client.joinRoom(communitySpaceAlias);
  await joinWorkspaceTree(client, room.roomId);
  return room.roomId;
}

// ------------------------------------------------------------ members --

export interface WorkspaceMember {
  userId: string;
  displayName: string;
  avatarMxc: string | null;
  role: WorkspaceRole;
  powerLevel: number;
}

export function workspaceMembers(space: Room): WorkspaceMember[] {
  return space
    .getJoinedMembers()
    .map((m) => ({
      userId: m.userId,
      displayName: m.name,
      avatarMxc: m.getMxcAvatarUrl() ?? null,
      role: roleFromPowerLevel(m.powerLevel),
      powerLevel: m.powerLevel,
    }))
    .sort((a, b) => b.powerLevel - a.powerLevel || compareByName({ name: a.displayName }, { name: b.displayName }));
}

/** Joined rooms under the Space that we can see: its channels, its categories, their channels. */
export function joinedChildRooms(client: MatrixClient, space: Room): Room[] {
  const tree = workspaceTree(client, space);
  const rooms: Room[] = [];
  for (const category of tree.categories) {
    if (category.room?.getMyMembership() === KnownMembership.Join) rooms.push(category.room);
  }
  for (const child of [...tree.uncategorised, ...tree.categories.flatMap((c) => c.children)]) {
    const room = client.getRoom(child.roomId);
    if (room && room.getMyMembership() === KnownMembership.Join) rooms.push(room);
  }
  return rooms;
}

/**
 * Change a member's role in the workspace: on the Space and on every channel
 * we can reach, so an admin can manage channels, not just the Space.
 */
export async function setWorkspaceRole(client: MatrixClient, space: Room, userId: string, role: WorkspaceRole): Promise<void> {
  const level = ROLE_POWER_LEVEL[role];
  await client.setPowerLevel(space.roomId, userId, level);
  for (const room of joinedChildRooms(client, space)) {
    try {
      await client.setPowerLevel(room.roomId, userId, level);
    } catch {
      // A channel where we are not admin keeps its own levels.
    }
  }
}

/**
 * Memberships in `roomId` as the server reports them (`/members`, everyone
 * but those who left), keyed by user id. The local room only holds what
 * sliding sync lazy-loaded (`$ME`, `$LAZY`), so a member who never spoke is
 * invisible there; a decision about someone's access must not rely on it.
 */
export async function serverMemberships(client: MatrixClient, roomId: string): Promise<Map<string, string>> {
  // The SDK types this as a dict; the endpoint (and the SDK's own
  // `loadMembersFromServer`) return `{ chunk: [...] }`.
  const response = (await client.members(roomId, undefined, KnownMembership.Leave)) as unknown as {
    chunk?: { state_key?: string; content?: { membership?: string } }[];
  };
  const memberships = new Map<string, string>();
  for (const event of response.chunk ?? []) {
    const membership = event.content?.membership;
    if (event.state_key && membership) memberships.set(event.state_key, membership);
  }
  return memberships;
}

export interface RemoveMemberOutcome {
  /** Channels the person was kicked out of (or invited to, and uninvited). */
  revoked: string[];
  /** Channels where the kick failed: the person is still in them. */
  failed: { roomId: string; message: string }[];
  /** Channels of the Space we are not in ourselves: nothing can be checked or revoked there. */
  unreachable: string[];
}

/**
 * Remove someone from the workspace: every channel of the Space first, the
 * Space last. A restricted join rule only governs *joining*: kicking from
 * the Space does not end existing channel memberships, so each channel is
 * checked against the server and the ones we could not clear are reported
 * rather than assumed done. Throws only when the Space kick itself fails.
 */
export async function removeWorkspaceMember(
  client: MatrixClient,
  space: Room,
  userId: string,
  reason?: string,
): Promise<RemoveMemberOutcome> {
  const outcome: RemoveMemberOutcome = { revoked: [], failed: [], unreachable: [] };
  for (const child of spaceChildren(space, (id) => id)) {
    const room = client.getRoom(child.roomId);
    if (!room || room.getMyMembership() !== KnownMembership.Join) {
      outcome.unreachable.push(child.roomId);
      continue;
    }
    let membership: string | undefined;
    try {
      membership = (await serverMemberships(client, room.roomId)).get(userId);
    } catch (error) {
      outcome.failed.push({ roomId: room.roomId, message: messageOf(error) });
      continue;
    }
    if (membership !== KnownMembership.Join && membership !== KnownMembership.Invite) continue;
    try {
      await client.kick(room.roomId, userId, reason);
      outcome.revoked.push(room.roomId);
    } catch (error) {
      outcome.failed.push({ roomId: room.roomId, message: messageOf(error) });
    }
  }
  await client.kick(space.roomId, userId, reason);
  return outcome;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Other owners in the Space (for the "transfer first" rule). */
export function otherOwners(space: Room, me: string): WorkspaceMember[] {
  return workspaceMembers(space).filter((m) => m.role === "owner" && m.userId !== me);
}

/** Thrown by `leaveWorkspace` when leaving would orphan the workspace. */
export class SoleOwnerError extends Error {
  constructor(spaceName: string) {
    super(`You are the only owner of ${spaceName}. Make someone else an owner before leaving, or delete the workspace.`);
    this.name = "SoleOwnerError";
  }
}

/**
 * Leave the workspace: every channel, then the Space. Refuses (throws
 * `SoleOwnerError`) when we are the only owner and others remain: nobody
 * left behind could promote a replacement, invite or remove anyone. The
 * roster comes from the server; the local one is lazy-loaded and may lack
 * the very co-owner that would make leaving fine.
 */
export async function leaveWorkspace(client: MatrixClient, space: Room): Promise<void> {
  const me = client.getUserId() ?? "";
  if (roleFromPowerLevel(powerLevelOf(space, me)) === "owner") {
    const roster = await serverMemberships(client, space.roomId);
    const others = [...roster].filter(([userId, membership]) => userId !== me && membership === KnownMembership.Join);
    const otherOwner = others.some(([userId]) => roleFromPowerLevel(powerLevelOf(space, userId)) === "owner");
    if (others.length > 0 && !otherOwner) throw new SoleOwnerError(space.name);
  }
  for (const room of joinedChildRooms(client, space)) {
    try {
      await client.leave(room.roomId);
    } catch {
      // Best effort per channel.
    }
  }
  await client.leave(space.roomId);
}

export interface DeleteWorkspaceOutcome {
  /** Nobody is left anywhere we could reach and every step went through. */
  complete: boolean;
  /** People still in a room after the deletion (the kick failed, or they came back). */
  membersLeft: { roomId: string; userId: string; message: string }[];
  /** Channels of the Space we are not in ourselves: untouched. */
  unreachable: string[];
  /** Steps that failed without leaving anyone in (tombstone, unlink, leave). */
  problems: string[];
}

/** Power level of `userId` in `room` per its `m.room.power_levels` (state we always sync). */
function powerLevelOf(room: Room, userId: string): number {
  const content = room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() as
    | { users?: Record<string, number>; users_default?: number }
    | undefined;
  return content?.users?.[userId] ?? content?.users_default ?? 0;
}

/**
 * Delete the workspace. Matrix has no room deletion; the closest is: kick
 * everyone, mark every channel with a tombstone so clients hide it, and
 * leave. History stays on the server (as Slack keeps it) but nobody is in
 * the rooms any more.
 *
 * Rosters come from the server (`/members`), not the lazy-loaded local
 * copy, and each room is read back after the kicks: whoever is still in
 * is reported, not assumed gone. Refuses up front when another member has
 * our power or more — Matrix will not let us kick them, so the workspace
 * would survive with them in it under the name "deleted".
 */
export async function deleteWorkspace(client: MatrixClient, space: Room): Promise<DeleteWorkspaceOutcome> {
  const me = client.getUserId() ?? "";
  const body = `${space.name} was deleted`;
  const outcome: DeleteWorkspaceOutcome = { complete: true, membersLeft: [], unreachable: [], problems: [] };

  const spaceRoster = await serverMemberships(client, space.roomId);
  const myLevel = powerLevelOf(space, me);
  const peers = [...spaceRoster]
    .filter(([userId, membership]) => userId !== me && membership === KnownMembership.Join && powerLevelOf(space, userId) >= myLevel)
    .map(([userId]) => userId);
  if (peers.length > 0) {
    throw new Error(`${peers.join(", ")} ${peers.length === 1 ? "is" : "are"} also owner of ${space.name}. Only a sole owner can delete a workspace.`);
  }

  const tree = workspaceTree(client, space);
  const rooms: Room[] = [];
  for (const child of [...tree.uncategorised, ...tree.categories.flatMap((c) => c.children)]) {
    const room = client.getRoom(child.roomId);
    if (room && room.getMyMembership() === KnownMembership.Join) rooms.push(room);
    else outcome.unreachable.push(child.roomId);
  }
  // Categories after their channels: a category is closed once it is empty.
  for (const category of tree.categories) {
    if (category.room?.getMyMembership() === KnownMembership.Join) rooms.push(category.room);
  }
  rooms.push(space);

  const isIn = (membership: string | undefined) => membership === KnownMembership.Join || membership === KnownMembership.Invite;

  for (const room of rooms) {
    let roster: Map<string, string>;
    try {
      roster = room.roomId === space.roomId ? spaceRoster : await serverMemberships(client, room.roomId);
    } catch (error) {
      outcome.problems.push(`Could not list the members of #${room.name}: ${messageOf(error)}`);
      continue;
    }
    const failedHere = new Set<string>();
    for (const [userId, membership] of roster) {
      if (userId === me || !isIn(membership)) continue;
      try {
        await client.kick(room.roomId, userId, body);
      } catch (error) {
        failedHere.add(userId);
        outcome.membersLeft.push({ roomId: room.roomId, userId, message: messageOf(error) });
      }
    }
    // Read back: the kicks that returned 200 are done; anyone else still in
    // (a race, a re-join) is reported too.
    try {
      for (const [userId, membership] of await serverMemberships(client, room.roomId)) {
        if (userId === me || !isIn(membership) || failedHere.has(userId)) continue;
        outcome.membersLeft.push({ roomId: room.roomId, userId, message: "still a member after the kick" });
      }
    } catch (error) {
      outcome.problems.push(`Could not verify #${room.name} is empty: ${messageOf(error)}`);
    }

    if (room.roomId !== space.roomId) {
      try {
        await client.sendStateEvent(room.roomId, EventType.RoomTombstone, { body, replacement_room: "" }, "");
      } catch (error) {
        outcome.problems.push(`Could not close #${room.name}: ${messageOf(error)}`);
      }
      try {
        await unlinkChannel(client, tree.containerOf.get(room.roomId) ?? space.roomId, room.roomId);
      } catch (error) {
        outcome.problems.push(`Could not unlink #${room.name}: ${messageOf(error)}`);
      }
    }
  }

  for (const room of rooms) {
    try {
      await client.leave(room.roomId);
    } catch (error) {
      outcome.problems.push(`Could not leave ${room.roomId === space.roomId ? space.name : `#${room.name}`}: ${messageOf(error)}`);
    }
  }

  outcome.complete = outcome.membersLeft.length === 0 && outcome.unreachable.length === 0 && outcome.problems.length === 0;
  return outcome;
}

// ----------------------------------------------------------- channels --

/** Remove the child link (empty content = removed, per spec). */
export async function unlinkChannel(client: MatrixClient, spaceId: string, roomId: string): Promise<void> {
  await client.sendStateEvent(spaceId, EventType.SpaceChild, {}, roomId);
}

/**
 * Archive a channel: unlink it from the Space and leave it. History stays
 * on the server for whoever is still in the room; the channel disappears
 * from the workspace.
 */
export async function archiveChannel(client: MatrixClient, spaceId: string, roomId: string): Promise<void> {
  const space = client.getRoom(spaceId);
  const containerId = (space && workspaceTree(client, space).containerOf.get(roomId)) ?? spaceId;
  await unlinkChannel(client, containerId, roomId);
  try {
    await client.sendStateEvent(roomId, EventType.SpaceParent, {}, containerId);
  } catch {
    // Not ours to edit; the Space-side unlink is what matters.
  }
  await client.leave(roomId);
}

/**
 * Rewrite `order` on every listed child so `space` lists them in
 * `orderedRoomIds` order. `space` is whichever Space links them: the
 * workspace for its uncategorised channels and its categories, a category
 * for its channels. Categories and uncategorised channels share the
 * workspace's key space; each kind is only ever sorted against its own.
 */
export async function reorderChannels(client: MatrixClient, space: Room, orderedRoomIds: readonly string[]): Promise<void> {
  const current = new Map(spaceChildren(space, (id) => id).map((c) => [c.roomId, c]));
  for (const [index, roomId] of orderedRoomIds.entries()) {
    const child = current.get(roomId);
    if (!child) continue;
    const order = channelOrderKey(index);
    if (child.order === order) continue;
    await client.sendStateEvent(space.roomId, EventType.SpaceChild, { via: child.via, suggested: child.suggested, order }, roomId);
  }
}

/** Toggle a channel as default (suggested) for newcomers, wherever in the workspace it is listed. */
export async function setChannelDefault(client: MatrixClient, space: Room, roomId: string, isDefault: boolean): Promise<void> {
  const tree = workspaceTree(client, space);
  const containerId = tree.containerOf.get(roomId);
  const child = [...tree.uncategorised, ...tree.categories.flatMap((c) => c.children)].find((c) => c.roomId === roomId);
  if (!child || !containerId) return;
  await client.sendStateEvent(
    containerId,
    EventType.SpaceChild,
    { via: child.via, suggested: isDefault, ...(child.order ? { order: child.order } : {}) },
    roomId,
  );
}

// --------------------------------------------------------- categories --

/**
 * `createRoom` options for a category of `space`: a private Space, join
 * rule restricted to the workspace's members (so the client can join it
 * silently for everyone), canonical parent link to the workspace, and the
 * workspace's power levels copied so its admins can file channels in it
 * from day one (`state_default` 50 covers `m.space.child`).
 */
export function categoryCreateOptions(client: MatrixClient, space: Room, name: string) {
  const via = [serverName(client)];
  const me = client.getUserId() ?? "";
  const spaceUsers = (space.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() as { users?: Record<string, number> } | undefined)?.users ?? {};
  const powerLevels = workspaceChannelPowerLevels(me);
  powerLevels.users = { ...spaceUsers, [me]: ROLE_POWER_LEVEL.owner };
  const initialState: InitialStateEvent[] = [
    {
      type: EventType.RoomJoinRules,
      state_key: "",
      content: { join_rule: JoinRule.Restricted, allow: CHANNEL_JOIN_RULE_ALLOW(space.roomId) },
    },
    {
      type: EventType.SpaceParent,
      state_key: space.roomId,
      content: { via, canonical: true },
    },
  ];
  return {
    name: name.trim(),
    creation_content: { type: "m.space" },
    visibility: Visibility.Private,
    power_level_content_override: powerLevels,
    initial_state: initialState,
  };
}

/**
 * Add a category to the workspace: a child Space, linked after every child
 * the workspace has today. Checked against the workspace's power levels
 * first (linking is the admin act); if the link fails the Space we just
 * made is left rather than kept as a stray.
 */
export async function createCategory(client: MatrixClient, space: Room, name: string): Promise<string> {
  if (!canCreateChannels(space, client.getUserId() ?? "")) {
    throw new Error(`You cannot add categories to ${space.name}. Ask an admin or owner.`);
  }
  const room = await client.createRoom(categoryCreateOptions(client, space, name));
  try {
    await linkChannel(client, space.roomId, room.room_id, { suggested: false, order: nextChildOrderKey(space) });
  } catch (error) {
    try {
      await client.leave(room.room_id);
    } catch {
      // Best effort.
    }
    throw error;
  }
  return room.room_id;
}

export async function renameCategory(client: MatrixClient, categoryId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await client.setRoomName(categoryId, trimmed);
}

/**
 * Move a channel between the workspace (`targetId === space.roomId`, i.e.
 * uncategorised) and its categories: link it under the target, last, then
 * drop the old link; the channel's own `m.space.parent` follows when we
 * may edit it. Its join rule is untouched — it names the workspace, and a
 * category has no say in who enters. Link first, unlink second: a failure
 * half-way leaves the channel listed twice, never nowhere.
 */
export async function moveChannelToCategory(client: MatrixClient, space: Room, roomId: string, targetId: string, order?: string): Promise<void> {
  const tree = workspaceTree(client, space);
  const fromId = tree.containerOf.get(roomId) ?? space.roomId;
  if (fromId === targetId) return;
  const target = client.getRoom(targetId);
  if (!target) throw new Error("That category is not available yet.");
  const link = [...tree.uncategorised, ...tree.categories.flatMap((c) => c.children)].find((c) => c.roomId === roomId);
  const via = link?.via ?? [serverName(client)];
  await client.sendStateEvent(
    targetId,
    EventType.SpaceChild,
    { via, suggested: link?.suggested ?? false, order: order ?? nextChildOrderKey(target) },
    roomId,
  );
  await unlinkChannel(client, fromId, roomId);
  try {
    await client.sendStateEvent(roomId, EventType.SpaceParent, { via, canonical: true }, targetId);
    await client.sendStateEvent(roomId, EventType.SpaceParent, {}, fromId);
  } catch {
    // Not ours to edit; the Space-side links are what the grouping reads.
  }
}

/**
 * Delete a category: its channels go back to the workspace (uncategorised,
 * after the existing ones, in their category order), then the category
 * Space is closed (tombstoned), unlinked and left. No channel and no
 * message is lost.
 */
export async function deleteCategory(client: MatrixClient, space: Room, categoryId: string): Promise<void> {
  const tree = workspaceTree(client, space);
  const category = tree.categories.find((c) => c.id === categoryId);
  if (!category) return;
  const base = spaceChildren(space, (id) => id).length;
  for (const [index, child] of category.children.entries()) {
    await moveChannelToCategory(client, space, child.roomId, space.roomId, channelOrderKey(base + index));
  }
  try {
    await client.sendStateEvent(categoryId, EventType.RoomTombstone, { body: `${category.name} was deleted`, replacement_room: "" }, "");
  } catch {
    // A category we cannot close is still unlinked below, which is what hides it.
  }
  await unlinkChannel(client, space.roomId, categoryId);
  try {
    await client.leave(categoryId);
  } catch {
    // Best effort.
  }
}

// ----------------------------------------------------------- settings --

export interface WorkspaceProfileChanges {
  name?: string;
  topic?: string;
  avatarMxc?: string | null;
}

export async function updateWorkspaceProfile(client: MatrixClient, space: Room, changes: WorkspaceProfileChanges): Promise<void> {
  if (changes.name !== undefined && changes.name.trim() && changes.name.trim() !== space.name) {
    await client.setRoomName(space.roomId, changes.name.trim());
  }
  if (changes.topic !== undefined) {
    await client.setRoomTopic(space.roomId, changes.topic.trim());
  }
  if (changes.avatarMxc !== undefined) {
    await client.sendStateEvent(space.roomId, EventType.RoomAvatar, changes.avatarMxc ? { url: changes.avatarMxc } : {}, "");
  }
}

/** Upload an image and return its `mxc://` URL. */
export async function uploadAvatar(client: MatrixClient, file: File): Promise<string> {
  const { content_uri } = await client.uploadContent(file, { name: file.name, type: file.type });
  return content_uri;
}

// ------------------------------------------------------------- people --

export interface DirectoryUser {
  userId: string;
  displayName: string;
  avatarMxc: string | null;
}

/** People on the homeserver matching `term` (`/user_directory/search`). */
export async function searchPeople(client: MatrixClient, term: string, limit = 10): Promise<DirectoryUser[]> {
  const trimmed = term.trim().replace(/^@/, "");
  if (!trimmed) return [];
  const result = await client.searchUserDirectory({ term: trimmed, limit });
  const me = client.getUserId();
  return result.results
    .filter((u) => u.user_id !== me)
    .map((u) => ({ userId: u.user_id, displayName: u.display_name ?? u.user_id, avatarMxc: u.avatar_url ?? null }));
}

/** Two-letter initials for a workspace avatar: "Acme Corp" -> "AC", "hippius" -> "HI". */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
