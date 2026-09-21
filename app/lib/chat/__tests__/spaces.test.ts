import { describe, expect, it, vi } from "vitest";
import type { MatrixClient, Room } from "matrix-js-sdk";

import type { RoomSummary } from "@/lib/chat/rooms";

/** What `ChatConfig.communitySpaceAlias` carries in production. */
const COMMUNITY_ALIAS = "#hippius:hippius.com";
import {
  acceptWorkspaceInvite,
  CHANNEL_JOIN_RULE_ALLOW,
  categoryParentId,
  channelOrderKey,
  createCategory,
  createWorkspace,
  createWorkspaceChannel,
  defaultChannelIds,
  deleteCategory,
  deleteWorkspace,
  fetchJoinableChannels,
  fetchWorkspaceHierarchy,
  groupChannelsByWorkspace,
  joinedChildRooms,
  joinNewCategories,
  leaveWorkspace,
  inviteToWorkspace,
  listWorkspaces,
  moveChannelToCategory,
  removeWorkspaceMember,
  roleFromPowerLevel,
  setChannelDefault,
  SoleOwnerError,
  spaceChildren,
  waitForJoinedRoom,
  workspaceBadges,
  workspaceTree,
} from "@/lib/chat/spaces";

// ---------------------------------------------------------------- fakes --

interface FakeStateEvent {
  type: string;
  stateKey: string;
  content: Record<string, unknown>;
  sender?: string;
}

interface FakeSpaceSpec {
  id: string;
  name: string;
  membership?: "join" | "invite" | "leave";
  type?: string;
  state?: FakeStateEvent[];
  myPowerLevel?: number;
  alias?: string | null;
  joinRule?: string;
  unread?: number;
  highlight?: number;
  members?: string[];
}

function fakeEvent(e: FakeStateEvent) {
  return {
    getType: () => e.type,
    getStateKey: () => e.stateKey,
    getContent: () => e.content,
    getSender: () => e.sender ?? "@someone:hippius.com",
  };
}

function fakeRoom(spec: FakeSpaceSpec): Room {
  const state = spec.state ?? [];
  const members = spec.members ?? ["@me:hippius.com"];
  return {
    roomId: spec.id,
    name: spec.name,
    getType: () => spec.type,
    isSpaceRoom: () => spec.type === "m.space",
    getMyMembership: () => spec.membership ?? "join",
    getCanonicalAlias: () => spec.alias ?? null,
    getJoinRule: () => spec.joinRule ?? "invite",
    getMxcAvatarUrl: () => null,
    getJoinedMemberCount: () => members.length,
    getJoinedMembers: () => members.map((userId) => ({ userId, name: userId, powerLevel: 0 })),
    getMember: (userId: string) =>
      userId === "@me:hippius.com"
        ? { userId, name: "me", powerLevel: spec.myPowerLevel ?? 0, events: { member: fakeEvent({ type: "m.room.member", stateKey: userId, content: {}, sender: "@inviter:hippius.com" }) } }
        : null,
    getUnreadNotificationCount: (kind: string) => (kind === "highlight" ? (spec.highlight ?? 0) : (spec.unread ?? 0)),
    currentState: {
      // The Space's channel power levels: state needs 50.
      maySendStateEvent: (_type: string, userId: string) => (userId === "@me:hippius.com" ? (spec.myPowerLevel ?? 0) : 0) >= 50,
      getStateEvents: (type: string, stateKey?: string) => {
        const matching = state.filter((e) => e.type === type);
        if (stateKey === undefined) return matching.map(fakeEvent);
        const found = matching.find((e) => e.stateKey === stateKey);
        return found ? fakeEvent(found) : null;
      },
    },
  } as unknown as Room;
}

function fakeClient(rooms: Room[]): MatrixClient {
  return {
    getUserId: () => "@me:hippius.com",
    getDomain: () => "hippius.com",
    getVisibleRooms: () => rooms,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getRoomPushRule: () => undefined,
  } as unknown as MatrixClient;
}

function channel(id: string, name: string, extra: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id,
    kind: "channel",
    name,
    topic: null,
    unread: 0,
    highlight: 0,
    muted: false,
    encrypted: false,
    isPublic: false,
    memberCount: 3,
    dmUserId: null,
    inviterId: null,
    lastActiveTs: 0,
    avatarMxc: null,
    spaceParents: [],
    ...extra,
  };
}

const child = (spaceId: string, roomId: string, content: Record<string, unknown> = { via: ["hippius.com"] }): FakeStateEvent => ({
  type: "m.space.child",
  stateKey: roomId,
  content,
});

// ---------------------------------------------------------------- tests --

describe("roleFromPowerLevel", () => {
  it("maps power levels to Slack-style roles", () => {
    expect(roleFromPowerLevel(100)).toBe("owner");
    expect(roleFromPowerLevel(150)).toBe("owner");
    expect(roleFromPowerLevel(50)).toBe("admin");
    expect(roleFromPowerLevel(99)).toBe("admin");
    expect(roleFromPowerLevel(0)).toBe("member");
    expect(roleFromPowerLevel(undefined)).toBe("member");
  });
});

describe("listWorkspaces", () => {
  it("flags no workspace as the community before the config has landed (empty alias)", () => {
    const rooms = [fakeRoom({ id: "!hippius", name: "Hippius", type: "m.space", alias: COMMUNITY_ALIAS, joinRule: "public" })];
    expect(listWorkspaces(fakeClient(rooms), "").workspaces[0]).toMatchObject({ isCommunity: false });
  });

  it("lists joined spaces only, with role, and flags the community space", () => {
    const rooms = [
      fakeRoom({ id: "!acme", name: "Acme", type: "m.space", myPowerLevel: 100 }),
      fakeRoom({ id: "!hippius", name: "Hippius", type: "m.space", alias: "#hippius:hippius.com", joinRule: "public" }),
      fakeRoom({ id: "!invited", name: "Invited Co", type: "m.space", membership: "invite" }),
      fakeRoom({ id: "!left", name: "Old", type: "m.space", membership: "leave" }),
      fakeRoom({ id: "!room", name: "not a space" }),
    ];
    const { workspaces, invites } = listWorkspaces(fakeClient(rooms), COMMUNITY_ALIAS);
    expect(workspaces.map((w) => w.id)).toEqual(["!acme", "!hippius"]);
    expect(workspaces[0]).toMatchObject({ name: "Acme", myRole: "owner", isCommunity: false });
    expect(workspaces[1]).toMatchObject({ myRole: "member", isCommunity: true, isPublic: true });
    expect(invites.map((i) => i.id)).toEqual(["!invited"]);
    expect(invites[0].inviterId).toBe("@inviter:hippius.com");
  });
});

describe("spaceChildren", () => {
  it("orders suggested first, then by `order`, then by name; drops removed links", () => {
    const space = fakeRoom({
      id: "!s",
      name: "S",
      type: "m.space",
      state: [
        child("!s", "!zeta", { via: ["hippius.com"], order: "b" }),
        child("!s", "!alpha", { via: ["hippius.com"], order: "c" }),
        child("!s", "!general", { via: ["hippius.com"], suggested: true, order: "z" }),
        child("!s", "!removed", {}),
        child("!s", "!noorder", { via: ["hippius.com"] }),
      ],
    });
    const names: Record<string, string> = { "!zeta": "zeta", "!alpha": "alpha", "!general": "general", "!noorder": "Noorder" };
    const children = spaceChildren(space, (id) => names[id] ?? id);
    expect(children.map((c) => c.roomId)).toEqual(["!general", "!zeta", "!alpha", "!noorder"]);
    expect(children[0].suggested).toBe(true);
  });
});

describe("groupChannelsByWorkspace", () => {
  it("scopes channels to their space via m.space.child, falling back to m.space.parent", () => {
    const acme = fakeRoom({
      id: "!acme",
      name: "Acme",
      type: "m.space",
      state: [child("!acme", "!general", { via: ["hippius.com"], suggested: true }), child("!acme", "!random", { via: ["hippius.com"], order: "1" })],
    });
    const other = fakeRoom({ id: "!other", name: "Other", type: "m.space", state: [] });
    const client = fakeClient([acme, other]);
    const channels = [
      channel("!random", "random"),
      channel("!general", "general"),
      channel("!byparent", "by-parent", { spaceParents: ["!other"] }),
      channel("!loose", "loose"),
    ];
    const grouped = groupChannelsByWorkspace(client, channels);
    expect(grouped.byWorkspace.get("!acme")?.map((c) => c.id)).toEqual(["!general", "!random"]);
    expect(grouped.byWorkspace.get("!other")?.map((c) => c.id)).toEqual(["!byparent"]);
    expect(grouped.orphans.map((c) => c.id)).toEqual(["!loose"]);
  });
});

describe("workspaceBadges", () => {
  it("sums unread and mentions per workspace, skipping muted channels", () => {
    const byWorkspace = new Map<string, RoomSummary[]>([
      ["!a", [channel("!1", "one", { unread: 3, highlight: 1 }), channel("!2", "two", { unread: 9, highlight: 9, muted: true })]],
      ["!b", [channel("!3", "three", { unread: 0 })]],
    ]);
    const badges = workspaceBadges(byWorkspace);
    expect(badges.get("!a")).toEqual({ unread: 3, highlight: 1 });
    expect(badges.get("!b")).toEqual({ unread: 0, highlight: 0 });
  });
});

describe("channelOrderKey", () => {
  it("produces lexicographically sortable keys", () => {
    const keys = [0, 1, 9, 10, 100].map(channelOrderKey);
    expect([...keys].sort()).toEqual(keys);
  });
});

type CreateRoomOpts = {
  name?: string;
  visibility?: string;
  creation_content?: Record<string, unknown>;
  power_level_content_override?: Record<string, unknown>;
  initial_state?: { type: string; state_key?: string; content: Record<string, unknown> }[];
};

// Typed mocks so `mock.calls[i][j]` is typed; the parameters exist for that.
 
type CreateRoomFn = (opts: CreateRoomOpts) => Promise<{ room_id: string }>;
type SendStateFn = (roomId: string, type: string, content: Record<string, unknown>, stateKey?: string) => Promise<{ event_id: string }>;
type RoomIdFn = (roomId: string) => Promise<object>;
type InviteFn = (roomId: string, userId: string) => Promise<object>;
type KickFn = (roomId: string, userId: string, reason?: string) => Promise<object>;
 

describe("createWorkspace", () => {
  function clientWithCreateRoom() {
    let n = 0;
    const createRoom = vi.fn<CreateRoomFn>(async () => ({ room_id: `!room${++n}` }));
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    const leave = vi.fn<RoomIdFn>(async () => ({}));
    const client = {
      getUserId: () => "@me:hippius.com",
      getDomain: () => "hippius.com",
      createRoom,
      sendStateEvent,
      leave,
    } as unknown as MatrixClient;
    return { client, createRoom, sendStateEvent, leave };
  }

  it("creates the space, one restricted room per channel, and links them both ways", async () => {
    const { client, createRoom, sendStateEvent } = clientWithCreateRoom();

    const result = await createWorkspace(client, {
      name: "Acme",
      channels: [
        { name: "general", isDefault: true },
        { name: "random", isDefault: false },
      ],
    });

    expect(result).toEqual({ spaceId: "!room1", channelIds: ["!room2", "!room3"] });
    expect(createRoom).toHaveBeenCalledTimes(3);

    // 1. The space: private, creator is owner (100).
    expect(createRoom.mock.calls[0][0]).toMatchObject({
      name: "Acme",
      visibility: "private",
      creation_content: { type: "m.space" },
      power_level_content_override: { users: { "@me:hippius.com": 100 } },
    });

    // 2. Each channel: restricted to the space, history shared, canonical parent.
    const generalOpts = createRoom.mock.calls[1][0];
    expect(generalOpts.name).toBe("general");
    expect(generalOpts.visibility).toBe("private");
    const byType = Object.fromEntries((generalOpts.initial_state ?? []).map((s) => [s.type, s]));
    expect(byType["m.room.join_rules"].content).toEqual({
      join_rule: "restricted",
      allow: CHANNEL_JOIN_RULE_ALLOW("!room1"),
    });
    expect(byType["m.room.join_rules"].content.allow).toEqual([{ type: "m.room_membership", room_id: "!room1" }]);
    expect(byType["m.room.history_visibility"].content).toEqual({ history_visibility: "shared" });
    expect(byType["m.space.parent"]).toMatchObject({ state_key: "!room1", content: { canonical: true, via: ["hippius.com"] } });
    // Workspace channels are not end-to-end encrypted: anyone who joins later
    // must be able to read what was said (restricted join = Slack public channel).
    expect(byType["m.room.encryption"]).toBeUndefined();
    // The Space governs membership; the channel must not offer a way around
    // it. An explicit invite lets anyone join a restricted room, so inviting
    // is an admin action (50), not the preset's 0. Talking stays open.
    expect(generalOpts.power_level_content_override).toMatchObject({
      users: { "@me:hippius.com": 100 },
      users_default: 0,
      invite: 50,
      kick: 50,
      state_default: 50,
      events_default: 0,
      events: { "m.room.power_levels": 100, "m.space.parent": 50 },
    });

    // 3. Child links on the space: general suggested (default channel), ordered.
    expect(sendStateEvent).toHaveBeenCalledTimes(2);
    expect(sendStateEvent.mock.calls[0]).toEqual([
      "!room1",
      "m.space.child",
      { via: ["hippius.com"], suggested: true, order: channelOrderKey(0) },
      "!room2",
    ]);
    expect(sendStateEvent.mock.calls[1]).toEqual([
      "!room1",
      "m.space.child",
      { via: ["hippius.com"], suggested: false, order: channelOrderKey(1) },
      "!room3",
    ]);
  });

  it("puts the avatar on the space when given", async () => {
    const { client, createRoom } = clientWithCreateRoom();
    await createWorkspace(client, { name: "Acme", avatarMxc: "mxc://hippius.com/abc", channels: [] });
    const opts = createRoom.mock.calls[0][0];
    expect(opts.initial_state).toContainEqual({ type: "m.room.avatar", state_key: "", content: { url: "mxc://hippius.com/abc" } });
  });

  it("cleans up everything it created when a step fails", async () => {
    const { client, createRoom, leave } = clientWithCreateRoom();
    createRoom
      .mockImplementationOnce(async () => ({ room_id: "!space" }))
      .mockImplementationOnce(async () => ({ room_id: "!general" }))
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      });

    await expect(
      createWorkspace(client, { name: "Acme", channels: [{ name: "general", isDefault: true }, { name: "random", isDefault: false }] }),
    ).rejects.toThrow("boom");

    // Left in reverse order: channels first, the space last.
    expect(leave.mock.calls.map((c) => c[0])).toEqual(["!general", "!space"]);
  });
});

describe("inviteToWorkspace", () => {
  it("invites each person to the space and to every default channel", async () => {
    const invite = vi.fn<InviteFn>(async () => ({}));
    const client = { invite, getUserId: () => "@me:hippius.com" } as unknown as MatrixClient;
    const outcome = await inviteToWorkspace(client, "!space", ["@a:hippius.com", "@b:hippius.com"], ["!general", "!announce"]);
    expect(invite.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["!space", "@a:hippius.com"],
      ["!general", "@a:hippius.com"],
      ["!announce", "@a:hippius.com"],
      ["!space", "@b:hippius.com"],
      ["!general", "@b:hippius.com"],
      ["!announce", "@b:hippius.com"],
    ]);
    expect(outcome).toEqual({ invited: ["@a:hippius.com", "@b:hippius.com"], failed: [] });
  });

  it("reports a person as failed only when the Space invite fails; channel failures are tolerated", async () => {
    const invite = vi.fn(async (roomId: string, userId: string) => {
      if (userId === "@bad:hippius.com" && roomId === "!space") throw new Error("M_FORBIDDEN");
      if (userId === "@ok:hippius.com" && roomId === "!general") throw new Error("already in room");
      return {};
    });
    const client = { invite, getUserId: () => "@me:hippius.com" } as unknown as MatrixClient;
    const outcome = await inviteToWorkspace(client, "!space", ["@bad:hippius.com", "@ok:hippius.com"], ["!general"]);
    expect(outcome.invited).toEqual(["@ok:hippius.com"]);
    expect(outcome.failed).toEqual([{ userId: "@bad:hippius.com", message: "M_FORBIDDEN" }]);
  });
});

describe("removeWorkspaceMember", () => {
  const membersResponse = (chunk: { state_key: string; membership: string }[]) => ({
    chunk: chunk.map((m) => ({ type: "m.room.member", state_key: m.state_key, content: { membership: m.membership } })),
  });

  function setup() {
    const space = fakeRoom({
      id: "!space",
      name: "Acme",
      type: "m.space",
      state: [child("!space", "!general"), child("!space", "!random"), child("!space", "!secret")],
    });
    // We are in #general and #random; #secret is a channel of the Space we never joined.
    const general = fakeRoom({ id: "!general", name: "general" });
    const random = fakeRoom({ id: "!random", name: "random" });
    const kick = vi.fn<KickFn>(async () => ({}));
    const members = vi.fn(async (roomId: string) => {
      // The server knows Bob is in both channels even though the lazy-loaded
      // local rooms (`getMember` -> null for anyone but me) do not.
      if (roomId === "!general") return membersResponse([{ state_key: "@bob:hippius.com", membership: "join" }]);
      if (roomId === "!random") return membersResponse([{ state_key: "@bob:hippius.com", membership: "invite" }]);
      return membersResponse([]);
    });
    const client = { ...fakeClient([space, general, random]), kick, members } as unknown as MatrixClient;
    return { client, space, kick, members };
  }

  it("checks each channel against the server, kicks where the person is, then kicks from the Space", async () => {
    const { client, space, kick, members } = setup();
    const outcome = await removeWorkspaceMember(client, space, "@bob:hippius.com");
    expect(members.mock.calls.map((c) => c[0])).toEqual(["!general", "!random"]);
    expect(kick.mock.calls.map((c) => c[0])).toEqual(["!general", "!random", "!space"]);
    expect(outcome).toEqual({ revoked: ["!general", "!random"], failed: [], unreachable: ["!secret"] });
  });

  it("reports a failed channel kick instead of swallowing it, and still kicks from the Space", async () => {
    const { client, space, kick } = setup();
    kick.mockImplementation(async (roomId: string) => {
      if (roomId === "!random") throw new Error("M_FORBIDDEN");
      return {};
    });
    const outcome = await removeWorkspaceMember(client, space, "@bob:hippius.com");
    expect(outcome.revoked).toEqual(["!general"]);
    expect(outcome.failed).toEqual([{ roomId: "!random", message: "M_FORBIDDEN" }]);
    expect(kick.mock.calls.at(-1)?.[0]).toBe("!space");
  });

  it("throws when the Space kick itself fails", async () => {
    const { client, space, kick } = setup();
    kick.mockImplementation(async (roomId: string) => {
      if (roomId === "!space") throw new Error("M_FORBIDDEN");
      return {};
    });
    await expect(removeWorkspaceMember(client, space, "@bob:hippius.com")).rejects.toThrow("M_FORBIDDEN");
  });
});

describe("deleteWorkspace", () => {
  type Roster = Record<string, { state_key: string; membership: string }[]>;
  const powerLevels = (users: Record<string, number>): FakeStateEvent => ({ type: "m.room.power_levels", stateKey: "", content: { users, users_default: 0 } });

  function setup(roster: Roster, spaceUsers: Record<string, number> = { "@me:hippius.com": 100 }, children = ["!general", "!secret"]) {
    const space = fakeRoom({
      id: "!space",
      name: "Acme",
      type: "m.space",
      state: [...children.map((id) => child("!space", id)), powerLevels(spaceUsers)],
    });
    const general = fakeRoom({ id: "!general", name: "general" });
    const kick = vi.fn<KickFn>(async () => ({}));
    const leave = vi.fn<RoomIdFn>(async () => ({}));
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    // Each /members call returns the current roster; a successful kick removes the person.
    const members = vi.fn(async (roomId: string) => ({
      chunk: (roster[roomId] ?? []).map((m) => ({ type: "m.room.member", state_key: m.state_key, content: { membership: m.membership } })),
    }));
    kick.mockImplementation(async (roomId, userId) => {
      roster[roomId] = (roster[roomId] ?? []).filter((m) => m.state_key !== userId);
      return {};
    });
    const client = { ...fakeClient([space, general]), kick, leave, sendStateEvent, members } as unknown as MatrixClient;
    return { client, space, kick, leave, sendStateEvent, members };
  }

  it("kicks everyone the server lists, tombstones and unlinks channels, leaves, and reports what it could not reach", async () => {
    const { client, space, kick, leave, sendStateEvent } = setup({
      "!space": [
        { state_key: "@me:hippius.com", membership: "join" },
        { state_key: "@bob:hippius.com", membership: "join" },
        { state_key: "@eve:hippius.com", membership: "invite" },
        { state_key: "@old:hippius.com", membership: "ban" },
      ],
      "!general": [
        { state_key: "@me:hippius.com", membership: "join" },
        { state_key: "@quiet:hippius.com", membership: "join" }, // never spoke: absent from the lazy-loaded room
      ],
    });
    const outcome = await deleteWorkspace(client, space);
    expect(kick.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ["!general", "@quiet:hippius.com"],
      ["!space", "@bob:hippius.com"],
      ["!space", "@eve:hippius.com"],
    ]);
    expect(sendStateEvent.mock.calls.map((c) => [c[0], c[1], c[3]])).toEqual([
      ["!general", "m.room.tombstone", ""],
      ["!space", "m.space.child", "!general"],
    ]);
    expect(leave.mock.calls.map((c) => c[0])).toEqual(["!general", "!space"]);
    expect(outcome).toEqual({ complete: false, membersLeft: [], unreachable: ["!secret"], problems: [] });
  });

  it("is complete when every child was reachable and emptied", async () => {
    const { client, space } = setup(
      { "!space": [{ state_key: "@me:hippius.com", membership: "join" }], "!general": [{ state_key: "@me:hippius.com", membership: "join" }] },
      undefined,
      ["!general"],
    );
    const outcome = await deleteWorkspace(client, space);
    expect(outcome).toEqual({ complete: true, membersLeft: [], unreachable: [], problems: [] });
  });

  it("reports members a kick could not remove and anyone still there on read-back", async () => {
    const roster: Roster = {
      "!space": [
        { state_key: "@me:hippius.com", membership: "join" },
        { state_key: "@bob:hippius.com", membership: "join" },
      ],
      "!general": [{ state_key: "@me:hippius.com", membership: "join" }],
    };
    const { client, space, kick, members } = setup(roster);
    kick.mockImplementation(async (roomId, userId) => {
      if (userId === "@bob:hippius.com") throw new Error("M_FORBIDDEN");
      return {};
    });
    // Someone joins #general between the roster read and the read-back.
    let generalReads = 0;
    members.mockImplementation(async (roomId: string) => {
      if (roomId === "!general" && ++generalReads === 2) roster["!general"].push({ state_key: "@late:hippius.com", membership: "join" });
      return { chunk: (roster[roomId] ?? []).map((m) => ({ type: "m.room.member", state_key: m.state_key, content: { membership: m.membership } })) };
    });
    const outcome = await deleteWorkspace(client, space);
    expect(outcome.complete).toBe(false);
    expect(outcome.membersLeft).toEqual([
      { roomId: "!general", userId: "@late:hippius.com", message: "still a member after the kick" },
      { roomId: "!space", userId: "@bob:hippius.com", message: "M_FORBIDDEN" },
    ]);
  });

  it("refuses when another member has our power: Matrix will not let us kick them", async () => {
    const { client, space, kick } = setup(
      {
        "!space": [
          { state_key: "@me:hippius.com", membership: "join" },
          { state_key: "@co:hippius.com", membership: "join" },
        ],
      },
      { "@me:hippius.com": 100, "@co:hippius.com": 100 },
    );
    await expect(deleteWorkspace(client, space)).rejects.toThrow("@co:hippius.com is also owner of Acme");
    expect(kick).not.toHaveBeenCalled();
  });
});

describe("fetchJoinableChannels", () => {
  const hierarchyRoom = (room_id: string, name: string, extra: Record<string, unknown> = {}) => ({
    room_id,
    name,
    num_joined_members: 4,
    world_readable: false,
    guest_can_join: false,
    children_state: [],
    ...extra,
  });

  it("lists hierarchy children we are not in, in the Space's child order, skipping sub-Spaces", async () => {
    const space = fakeRoom({
      id: "!space",
      name: "Acme",
      type: "m.space",
      state: [
        child("!space", "!general", { via: ["hippius.com"], suggested: true, order: "a" }),
        child("!space", "!ops", { via: ["other.example"], order: "b" }),
        child("!space", "!design", { via: ["hippius.com"], order: "c" }),
        child("!space", "!banned", { via: ["hippius.com"], order: "d" }),
      ],
    });
    const general = fakeRoom({ id: "!general", name: "general" });
    const banned = fakeRoom({ id: "!banned", name: "banned", membership: "ban" as never });
    const getRoomHierarchy = vi.fn(async (_id: string, _limit: number, _depth: number, _suggested: boolean, from?: string) =>
      from === undefined
        ? {
            rooms: [
              hierarchyRoom("!space", "Acme", { room_type: "m.space" }),
              hierarchyRoom("!ops", "ops", { topic: " on call " }),
              hierarchyRoom("!general", "general"),
              hierarchyRoom("!sub", "Sub", { room_type: "m.space" }),
            ],
            next_batch: "p2",
          }
        : {
            rooms: [hierarchyRoom("!design", "", { canonical_alias: "#design:hippius.com" }), hierarchyRoom("!banned", "banned"), hierarchyRoom("!stray", "stray")],
          },
    );
    const client = { ...fakeClient([space, general, banned]), getRoomHierarchy } as unknown as MatrixClient;
    const found = await fetchJoinableChannels(client, space);
    // Space order (ops before design), then the child the Space does not link (stray) last.
    expect(found.map((c) => c.roomId)).toEqual(["!ops", "!design", "!stray"]);
    expect(found[0]).toMatchObject({ name: "ops", topic: "on call", suggested: false, via: ["other.example"], memberCount: 4 });
    expect(found[1]).toMatchObject({ name: "design", topic: null, via: ["hippius.com"] });
    expect(found[2].via).toEqual(["hippius.com"]);
    expect(getRoomHierarchy).toHaveBeenCalledTimes(2);
    expect(getRoomHierarchy.mock.calls[1][4]).toBe("p2");
  });
});

describe("leaveWorkspace", () => {
  const powerLevels = (users: Record<string, number>): FakeStateEvent => ({ type: "m.room.power_levels", stateKey: "", content: { users, users_default: 0 } });
  const roster = (entries: Record<string, string>) => ({
    chunk: Object.entries(entries).map(([state_key, membership]) => ({ type: "m.room.member", state_key, content: { membership } })),
  });

  function setup(users: Record<string, number>, memberships: Record<string, string>) {
    const space = fakeRoom({ id: "!space", name: "Acme", type: "m.space", state: [child("!space", "!general"), powerLevels(users)] });
    const general = fakeRoom({ id: "!general", name: "general" });
    const leave = vi.fn<RoomIdFn>(async () => ({}));
    const members = vi.fn(async () => roster(memberships));
    const client = { ...fakeClient([space, general]), leave, members } as unknown as MatrixClient;
    return { client, space, leave, members };
  }

  it("refuses to let the only owner walk out on the others", async () => {
    const { client, space, leave } = setup({ "@me:hippius.com": 100, "@adm:hippius.com": 50 }, { "@me:hippius.com": "join", "@adm:hippius.com": "join" });
    await expect(leaveWorkspace(client, space)).rejects.toBeInstanceOf(SoleOwnerError);
    expect(leave).not.toHaveBeenCalled();
  });

  it("lets an owner leave when another owner remains, or when nobody else is left", async () => {
    const shared = setup({ "@me:hippius.com": 100, "@co:hippius.com": 100 }, { "@me:hippius.com": "join", "@co:hippius.com": "join" });
    await leaveWorkspace(shared.client, shared.space);
    expect(shared.leave.mock.calls.map((c) => c[0])).toEqual(["!general", "!space"]);

    // A co-owner who already left does not count.
    const alone = setup({ "@me:hippius.com": 100, "@co:hippius.com": 100 }, { "@me:hippius.com": "join", "@co:hippius.com": "leave" });
    await leaveWorkspace(alone.client, alone.space);
    expect(alone.leave).toHaveBeenCalledTimes(2);
  });

  it("does not consult the server for a plain member", async () => {
    const { client, space, leave, members } = setup({ "@own:hippius.com": 100 }, {});
    await leaveWorkspace(client, space);
    expect(members).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledTimes(2);
  });
});

describe("acceptWorkspaceInvite", () => {
  const link = (state_key: string, content: Record<string, unknown>) => ({ type: "m.space.child", state_key, content, sender: "@bot:hippius.com", origin_server_ts: 0 });

  it("reads the children from the server, since the joined Space is not synced yet, then accepts channel invites and joins the defaults", async () => {
    // Local state after joinRoom(): the Space exists but is empty; #general is a pending invite; #random unknown.
    const emptySpace = fakeRoom({ id: "!space", name: "Acme", type: "m.space", state: [] });
    const general = fakeRoom({ id: "!general", name: "general", membership: "invite" });
    const unrelated = fakeRoom({ id: "!other", name: "other", membership: "invite" });
    const joinRoom = vi.fn(async (...args: [roomId: string, opts?: { viaServers?: string[] }]) => ({ roomId: args[0] }));
    const getRoomHierarchy = vi.fn(async () => ({
      rooms: [
        {
          room_id: "!space",
          room_type: "m.space",
          num_joined_members: 3,
          world_readable: false,
          guest_can_join: false,
          children_state: [
            link("!general", { via: ["hippius.com"], suggested: true }),
            link("!random", { via: ["hippius.com"], suggested: true }),
            link("!design", { via: ["hippius.com"] }),
            link("!gone", {}),
          ],
        },
      ],
    }));
    const client = { ...fakeClient([emptySpace, general, unrelated]), joinRoom, getRoomHierarchy } as unknown as MatrixClient;
    await acceptWorkspaceInvite(client, "!space");
    // Two levels: the workspace's own children and those of its categories.
    expect(getRoomHierarchy).toHaveBeenCalledWith("!space", 100, 2, false, undefined);
    expect(joinRoom.mock.calls.map((c) => c[0])).toEqual(["!space", "!general", "!random"]);
    expect(joinRoom.mock.calls[2][1]).toEqual({ viaServers: ["hippius.com"] });
  });

  it("falls back to local state when the hierarchy endpoint is unavailable", async () => {
    const space = fakeRoom({ id: "!space", name: "Acme", type: "m.space", state: [child("!space", "!general", { via: ["hippius.com"], suggested: true })] });
    const joinRoom = vi.fn(async (roomId: string) => ({ roomId }));
    const getRoomHierarchy = vi.fn(async () => {
      throw new Error("M_UNRECOGNIZED");
    });
    const client = { ...fakeClient([space]), joinRoom, getRoomHierarchy } as unknown as MatrixClient;
    await acceptWorkspaceInvite(client, "!space");
    expect(joinRoom.mock.calls.map((c) => c[0])).toEqual(["!space", "!general"]);
  });
});

describe("createWorkspaceChannel", () => {
  const spec = { name: "design", order: "b" };

  it("refuses before creating anything when the Space does not let us link a channel", async () => {
    const space = fakeRoom({ id: "!space", name: "Acme", type: "m.space", myPowerLevel: 0 });
    const createRoom = vi.fn();
    const client = { ...fakeClient([space]), createRoom } as unknown as MatrixClient;
    await expect(createWorkspaceChannel(client, "!space", spec)).rejects.toThrow("You cannot add channels to Acme");
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("leaves the room it just created when the link into the Space fails", async () => {
    const space = fakeRoom({ id: "!space", name: "Acme", type: "m.space", myPowerLevel: 50 });
    const createRoom = vi.fn(async () => ({ room_id: "!new" }));
    const sendStateEvent = vi.fn<SendStateFn>(async () => {
      throw new Error("M_FORBIDDEN");
    });
    const leave = vi.fn<RoomIdFn>(async () => ({}));
    const client = { ...fakeClient([space]), createRoom, sendStateEvent, leave } as unknown as MatrixClient;
    await expect(createWorkspaceChannel(client, "!space", spec)).rejects.toThrow("Could not add #design to the workspace: M_FORBIDDEN");
    expect(leave).toHaveBeenCalledWith("!new");
  });

  it("creates then links when allowed", async () => {
    const space = fakeRoom({ id: "!space", name: "Acme", type: "m.space", myPowerLevel: 50 });
    const createRoom = vi.fn(async () => ({ room_id: "!new" }));
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    const client = { ...fakeClient([space]), createRoom, sendStateEvent } as unknown as MatrixClient;
    await expect(createWorkspaceChannel(client, "!space", spec)).resolves.toBe("!new");
    expect(sendStateEvent).toHaveBeenCalledWith("!space", "m.space.child", { via: ["hippius.com"], suggested: false, order: "b" }, "!new");
  });
});

describe("waitForJoinedRoom", () => {
  function eventClient(rooms: Room[]) {
    const listeners = new Map<string, Set<() => void>>();
    const client = {
      ...fakeClient(rooms),
      on: (name: string, fn: () => void) => (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(fn),
      off: (name: string, fn: () => void) => listeners.get(name)?.delete(fn),
    } as unknown as MatrixClient;
    const emit = (name: string) => listeners.get(name)?.forEach((fn) => fn());
    return { client, emit, listeners, rooms };
  }

  it("resolves at once when the room is already joined", async () => {
    const { client } = eventClient([fakeRoom({ id: "!space", name: "Acme" })]);
    await expect(waitForJoinedRoom(client, "!space")).resolves.toBe(true);
  });

  it("waits for sync to deliver the room, then stops listening", async () => {
    const { client, emit, listeners, rooms } = eventClient([]);
    const pending = waitForJoinedRoom(client, "!space", 1000);
    emit("Room"); // some other room arrived
    rooms.push(fakeRoom({ id: "!space", name: "Acme" }));
    emit("Room");
    await expect(pending).resolves.toBe(true);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { client } = eventClient([]);
      const pending = waitForJoinedRoom(client, "!space", 50);
      vi.advanceTimersByTime(60);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------ categories --

const parentOf = (spaceId: string, canonical = true): FakeStateEvent => ({
  type: "m.space.parent",
  stateKey: spaceId,
  content: { via: ["hippius.com"], canonical },
});

/** Workspace Acme: #general, then category "Eng" (#backend, #frontend), then #random, then category "Design" (empty). */
function acmeWithCategories(opts: { engMembership?: "join" | "invite" | "leave"; myPowerLevel?: number } = {}) {
  const acme = fakeRoom({
    id: "!acme",
    name: "Acme",
    type: "m.space",
    myPowerLevel: opts.myPowerLevel ?? 50,
    state: [
      child("!acme", "!general", { via: ["hippius.com"], suggested: true, order: "000000" }),
      child("!acme", "!eng", { via: ["hippius.com"], order: "000001" }),
      child("!acme", "!random", { via: ["hippius.com"], order: "000002" }),
      child("!acme", "!design", { via: ["hippius.com"], order: "000003" }),
    ],
  });
  const eng = fakeRoom({
    id: "!eng",
    name: "Eng",
    type: "m.space",
    membership: opts.engMembership,
    myPowerLevel: opts.myPowerLevel ?? 50,
    state: [
      parentOf("!acme"),
      child("!eng", "!backend", { via: ["hippius.com"], order: "000000" }),
      child("!eng", "!frontend", { via: ["hippius.com"], suggested: true, order: "000001" }),
    ],
  });
  const design = fakeRoom({ id: "!design", name: "Design", type: "m.space", myPowerLevel: opts.myPowerLevel ?? 50, state: [parentOf("!acme")] });
  const rooms = [acme, eng, design, fakeRoom({ id: "!general", name: "general" }), fakeRoom({ id: "!backend", name: "backend" }), fakeRoom({ id: "!frontend", name: "frontend" }), fakeRoom({ id: "!random", name: "random" })];
  return { acme, eng, design, rooms, client: fakeClient(rooms) };
}

describe("categoryParentId", () => {
  it("recognises a category by the workspace's child link or by its own canonical parent, never a workspace", () => {
    const { client, acme, eng, design } = acmeWithCategories();
    expect(categoryParentId(client, acme)).toBeNull();
    expect(categoryParentId(client, eng)).toBe("!acme");
    // Design is linked by Acme; drop the link and its own parent still tells.
    const loner = fakeRoom({ id: "!loner", name: "Loner", type: "m.space", state: [parentOf("!acme")] });
    expect(categoryParentId(fakeClient([acme, loner]), loner)).toBe("!acme");
    expect(categoryParentId(client, design)).toBe("!acme");
    // A non-canonical parent claim alone is not enough.
    const claimer = fakeRoom({ id: "!claimer", name: "Claimer", type: "m.space", state: [parentOf("!acme", false)] });
    expect(categoryParentId(fakeClient([acme, claimer]), claimer)).toBeNull();
    // A channel is never a category.
    expect(categoryParentId(client, client.getRoom("!general")!)).toBeNull();
  });
});

describe("listWorkspaces with categories", () => {
  it("does not list category Spaces as workspaces", () => {
    const { client } = acmeWithCategories();
    expect(listWorkspaces(client, COMMUNITY_ALIAS).workspaces.map((w) => w.id)).toEqual(["!acme"]);
  });
});

describe("workspaceTree", () => {
  it("splits the workspace's children into uncategorised channels and ordered categories, and knows each channel's container", () => {
    const { client, acme } = acmeWithCategories();
    const tree = workspaceTree(client, acme);
    expect(tree.uncategorised.map((c) => c.roomId)).toEqual(["!general", "!random"]);
    expect(tree.categories.map((c) => [c.id, c.name, c.children.map((x) => x.roomId)])).toEqual([
      ["!eng", "Eng", ["!frontend", "!backend"]],
      ["!design", "Design", []],
    ]);
    expect(tree.containerOf.get("!general")).toBe("!acme");
    expect(tree.containerOf.get("!backend")).toBe("!eng");
  });

  it("treats a category we have not joined yet as empty (its links are not synced)", () => {
    const { client, acme } = acmeWithCategories({ engMembership: "invite" });
    const tree = workspaceTree(client, acme);
    expect(tree.categories[0]).toMatchObject({ id: "!eng", children: [] });
  });
});

describe("groupChannelsByWorkspace with categories", () => {
  it("groups joined channels by category, uncategorised first; flat list keeps every channel", () => {
    const { client } = acmeWithCategories();
    const channels = ["!random", "!frontend", "!backend", "!general"].map((id) => channel(id, id.slice(1)));
    channels.push(channel("!moved", "moved", { spaceParents: ["!eng"] }));
    const grouped = groupChannelsByWorkspace(client, channels);
    const groups = grouped.groupsByWorkspace.get("!acme")!;
    expect(groups.uncategorised.map((c) => c.id)).toEqual(["!general", "!random"]);
    expect(groups.categories.map((c) => [c.name, c.channels.map((x) => x.id)])).toEqual([
      ["Eng", ["!frontend", "!backend", "!moved"]],
      ["Design", []],
    ]);
    expect(grouped.byWorkspace.get("!acme")?.map((c) => c.id)).toEqual(["!general", "!random", "!frontend", "!backend", "!moved"]);
    expect(grouped.byWorkspace.has("!eng")).toBe(false);
    expect(grouped.orphans).toEqual([]);
  });
});

describe("defaultChannelIds / joinedChildRooms with categories", () => {
  it("walk the categories too", () => {
    const { client, acme } = acmeWithCategories();
    expect(defaultChannelIds(client, acme)).toEqual(["!general", "!frontend"]);
    expect(joinedChildRooms(client, acme).map((r) => r.roomId)).toEqual(["!eng", "!design", "!general", "!random", "!frontend", "!backend"]);
  });
});

describe("createCategory", () => {
  it("refuses when the workspace does not let us link children", async () => {
    const { client, acme } = acmeWithCategories({ myPowerLevel: 0 });
    const createRoom = vi.fn();
    await expect(createCategory({ ...client, createRoom } as unknown as MatrixClient, acme, "Ops")).rejects.toThrow("You cannot add categories to Acme");
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("creates a restricted child Space with the workspace's admins, links it last, and leaves it if the link fails", async () => {
    const { client, acme } = acmeWithCategories();
    const original = acme.currentState.getStateEvents.bind(acme.currentState);
    acme.currentState.getStateEvents = ((type: string, stateKey?: string) => {
      if (type === "m.room.power_levels" && stateKey === "") return fakeEvent({ type, stateKey: "", content: { users: { "@me:hippius.com": 100, "@ada:hippius.com": 50 } } });
      return stateKey === undefined ? original(type) : original(type, stateKey);
    }) as never;
    const createRoom = vi.fn<CreateRoomFn>(async () => ({ room_id: "!ops" }));
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    const c = { ...client, createRoom, sendStateEvent } as unknown as MatrixClient;
    await expect(createCategory(c, acme, " Ops ")).resolves.toBe("!ops");
    const opts = createRoom.mock.calls[0][0];
    expect(opts.name).toBe("Ops");
    expect(opts.creation_content).toEqual({ type: "m.space" });
    expect(opts.visibility).toBe("private");
    expect(opts.power_level_content_override).toMatchObject({ users: { "@me:hippius.com": 100, "@ada:hippius.com": 50 }, state_default: 50 });
    expect(opts.initial_state).toEqual([
      { type: "m.room.join_rules", state_key: "", content: { join_rule: "restricted", allow: CHANNEL_JOIN_RULE_ALLOW("!acme") } },
      { type: "m.space.parent", state_key: "!acme", content: { via: ["hippius.com"], canonical: true } },
    ]);
    // Four children today -> order 000004.
    expect(sendStateEvent).toHaveBeenCalledWith("!acme", "m.space.child", { via: ["hippius.com"], suggested: false, order: "000004" }, "!ops");

    const failing = vi.fn<SendStateFn>(async () => {
      throw new Error("M_FORBIDDEN");
    });
    const leave = vi.fn<RoomIdFn>(async () => ({}));
    await expect(createCategory({ ...client, createRoom, sendStateEvent: failing, leave } as unknown as MatrixClient, acme, "Ops")).rejects.toThrow("M_FORBIDDEN");
    expect(leave).toHaveBeenCalledWith("!ops");
  });
});

describe("createWorkspaceChannel in a category", () => {
  it("links the channel under the category, points its parent there, and keeps the join rule on the workspace", async () => {
    const { client, acme } = acmeWithCategories();
    const createRoom = vi.fn<CreateRoomFn>(async () => ({ room_id: "!new" }));
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    const c = { ...client, createRoom, sendStateEvent } as unknown as MatrixClient;
    await createWorkspaceChannel(c, acme.roomId, { name: "infra", order: "000002", categoryId: "!eng" });
    const initial = createRoom.mock.calls[0][0].initial_state!;
    expect(initial.find((e) => e.type === "m.room.join_rules")?.content).toEqual({ join_rule: "restricted", allow: CHANNEL_JOIN_RULE_ALLOW("!acme") });
    expect(initial.find((e) => e.type === "m.space.parent")?.state_key).toBe("!eng");
    expect(sendStateEvent).toHaveBeenCalledWith("!eng", "m.space.child", { via: ["hippius.com"], suggested: false, order: "000002" }, "!new");
  });
});

describe("moveChannelToCategory", () => {
  it("links under the target last, unlinks from the old container, and moves the channel's canonical parent", async () => {
    const { client, acme } = acmeWithCategories();
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    const c = { ...client, sendStateEvent } as unknown as MatrixClient;
    await moveChannelToCategory(c, acme, "!general", "!eng");
    expect(sendStateEvent.mock.calls).toEqual([
      ["!eng", "m.space.child", { via: ["hippius.com"], suggested: true, order: "000002" }, "!general"],
      ["!acme", "m.space.child", {}, "!general"],
      ["!general", "m.space.parent", { via: ["hippius.com"], canonical: true }, "!eng"],
      ["!general", "m.space.parent", {}, "!acme"],
    ]);
    // Never touches the join rule.
    expect(sendStateEvent.mock.calls.some((call) => call[1] === "m.room.join_rules")).toBe(false);
  });

  it("moves back to the workspace (uncategorised) and is a no-op when already there", async () => {
    const { client, acme } = acmeWithCategories();
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    const c = { ...client, sendStateEvent } as unknown as MatrixClient;
    await moveChannelToCategory(c, acme, "!backend", "!acme");
    expect(sendStateEvent.mock.calls[0]).toEqual(["!acme", "m.space.child", { via: ["hippius.com"], suggested: false, order: "000004" }, "!backend"]);
    expect(sendStateEvent.mock.calls[1]).toEqual(["!eng", "m.space.child", {}, "!backend"]);
    sendStateEvent.mockClear();
    await moveChannelToCategory(c, acme, "!general", "!acme");
    expect(sendStateEvent).not.toHaveBeenCalled();
  });
});

describe("deleteCategory", () => {
  it("re-parents its channels to the workspace in order, closes, unlinks and leaves the category", async () => {
    const { client, acme } = acmeWithCategories();
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    const leave = vi.fn<RoomIdFn>(async () => ({}));
    const c = { ...client, sendStateEvent, leave } as unknown as MatrixClient;
    await deleteCategory(c, acme, "!eng");
    const spaceChildWrites = sendStateEvent.mock.calls.filter((call) => call[1] === "m.space.child");
    expect(spaceChildWrites).toEqual([
      ["!acme", "m.space.child", { via: ["hippius.com"], suggested: true, order: "000004" }, "!frontend"],
      ["!eng", "m.space.child", {}, "!frontend"],
      ["!acme", "m.space.child", { via: ["hippius.com"], suggested: false, order: "000005" }, "!backend"],
      ["!eng", "m.space.child", {}, "!backend"],
      ["!acme", "m.space.child", {}, "!eng"],
    ]);
    expect(sendStateEvent).toHaveBeenCalledWith("!eng", "m.room.tombstone", { body: "Eng was deleted", replacement_room: "" }, "");
    expect(leave).toHaveBeenCalledWith("!eng");
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

describe("setChannelDefault in a category", () => {
  it("writes to the container that lists the channel", async () => {
    const { client, acme } = acmeWithCategories();
    const sendStateEvent = vi.fn<SendStateFn>(async () => ({ event_id: "$e" }));
    await setChannelDefault({ ...client, sendStateEvent } as unknown as MatrixClient, acme, "!backend", true);
    expect(sendStateEvent).toHaveBeenCalledWith("!eng", "m.space.child", { via: ["hippius.com"], suggested: true, order: "000000" }, "!backend");
  });
});

describe("fetchWorkspaceHierarchy with categories", () => {
  const hroom = (room_id: string, name: string, extra: Record<string, unknown> = {}) => ({
    room_id,
    name,
    num_joined_members: 4,
    world_readable: false,
    guest_can_join: false,
    children_state: [],
    ...extra,
  });
  const link = (roomId: string, content: Record<string, unknown>) => ({ type: "m.space.child", state_key: roomId, content, sender: "@a:hippius.com", origin_server_ts: 1 });

  it("lists joinable channels of the workspace and of each category, and the categories we are not in", async () => {
    const { acme, rooms } = acmeWithCategories({ engMembership: "leave" });
    const getRoomHierarchy = vi.fn(async () => ({
      rooms: [
        hroom("!acme", "Acme", {
          room_type: "m.space",
          children_state: [link("!general", { via: ["hippius.com"], suggested: true, order: "000000" }), link("!eng", { via: ["hippius.com"], order: "000001" }), link("!ops", { via: ["hippius.com"], order: "000002" })],
        }),
        hroom("!general", "general"),
        hroom("!ops", "ops"),
        hroom("!eng", "Eng", { room_type: "m.space", children_state: [link("!backend", { via: ["hippius.com"] }), link("!infra", { via: ["hippius.com"] })] }),
        hroom("!backend", "backend"),
        hroom("!infra", "infra"),
      ],
    }));
    const client = { ...fakeClient(rooms.filter((r) => r.roomId !== "!eng")), getRoomHierarchy } as unknown as MatrixClient;
    const result = await fetchWorkspaceHierarchy(client, acme);
    expect(getRoomHierarchy).toHaveBeenCalledWith("!acme", 100, 2, false, undefined);
    expect(result.channels.map((c) => [c.roomId, c.categoryId, c.categoryName])).toEqual([
      ["!ops", null, null],
      ["!infra", "!eng", "Eng"],
    ]);
    expect(result.categories).toEqual([{ roomId: "!eng", name: "Eng", via: ["hippius.com"] }]);
  });
});

describe("joinNewCategories", () => {
  it("asks the server what the unknown children are and joins the Spaces among them", async () => {
    const { acme, rooms } = acmeWithCategories();
    const getRoomHierarchy = vi.fn(async () => ({
      rooms: [
        { room_id: "!acme", room_type: "m.space", num_joined_members: 1, world_readable: false, guest_can_join: false, children_state: [] },
        { room_id: "!eng", room_type: "m.space", num_joined_members: 1, world_readable: false, guest_can_join: false, children_state: [] },
        { room_id: "!random", num_joined_members: 1, world_readable: false, guest_can_join: false, children_state: [] },
      ],
    }));
    const joinRoom = vi.fn(async (roomId: string) => ({ roomId }));
    // We are not in !eng nor !random.
    const client = { ...fakeClient(rooms.filter((r) => r.roomId !== "!eng" && r.roomId !== "!random")), getRoomHierarchy, joinRoom } as unknown as MatrixClient;
    await expect(joinNewCategories(client, acme)).resolves.toBe(1);
    expect(getRoomHierarchy).toHaveBeenCalledWith("!acme", 100, 1, false, undefined);
    expect(joinRoom.mock.calls).toEqual([["!eng", { viaServers: ["hippius.com"] }]]);

    // Nothing unknown: no request.
    getRoomHierarchy.mockClear();
    await expect(joinNewCategories(fakeClient(rooms), acme)).resolves.toBe(0);
    expect(getRoomHierarchy).not.toHaveBeenCalled();
  });
});
