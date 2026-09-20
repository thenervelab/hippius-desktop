import { describe, expect, it } from "vitest";
import type { MatrixClient, Room } from "matrix-js-sdk";

import {
  directRoomMap,
  isValidUserId,
  normaliseUserId,
  roomLabel,
  slugifyChannelName,
  summariseRooms,
  totalUnread,
} from "@/lib/chat/rooms";

interface FakeRoomSpec {
  id: string;
  name: string;
  membership?: "join" | "invite" | "leave";
  members?: string[];
  named?: boolean;
  unread?: number;
  highlight?: number;
  lastActive?: number;
  topic?: string;
  type?: string;
  encrypted?: boolean;
  joinRule?: string;
}

function fakeRoom(spec: FakeRoomSpec): Room {
  const members = spec.members ?? ["@me:hippius.com", "@bob:hippius.com", "@carol:hippius.com"];
  const stateEvents: Record<string, unknown> = {};
  if (spec.named ?? true) stateEvents["m.room.name"] = { getContent: () => ({ name: spec.name }) };
  if (spec.topic) stateEvents["m.room.topic"] = { getContent: () => ({ topic: spec.topic }) };
  return {
    roomId: spec.id,
    name: spec.name,
    getMyMembership: () => spec.membership ?? "join",
    getType: () => spec.type,
    currentState: {
      getStateEvents: (type: string) => stateEvents[type] ?? null,
    },
    getDMInviter: () => undefined,
    getJoinedMembers: () => members.map((userId) => ({ userId, name: userId.slice(1).split(":")[0] })),
    getJoinedMemberCount: () => members.length,
    getMember: (userId: string) => ({ userId, name: userId.slice(1).split(":")[0], events: {} }),
    getJoinRule: () => spec.joinRule ?? "invite",
    getUnreadNotificationCount: (type: string) =>
      type === "highlight" ? (spec.highlight ?? 0) : (spec.unread ?? 0),
    hasEncryptionStateEvent: () => spec.encrypted ?? false,
    getLastActiveTimestamp: () => spec.lastActive ?? 0,
    getMxcAvatarUrl: () => null,
  } as unknown as Room;
}

function fakeClient(rooms: Room[], direct: Record<string, string[]> = {}, muted: string[] = []): MatrixClient {
  return {
    getUserId: () => "@me:hippius.com",
    getVisibleRooms: () => rooms,
    getAccountData: (type: string) =>
      type === "m.direct" ? { getContent: () => direct } : undefined,
    getRoomPushRule: (_scope: string, roomId: string) =>
      muted.includes(roomId) ? { enabled: true, actions: ["dont_notify"] } : undefined,
    getUser: () => null,
  } as unknown as MatrixClient;
}

describe("summariseRooms", () => {
  it("splits channels, DMs and invites and sorts them Slack-style", () => {
    const rooms = [
      fakeRoom({ id: "!zeta", name: "zeta", lastActive: 10 }),
      fakeRoom({ id: "!alpha", name: "Alpha", lastActive: 20, unread: 3, highlight: 1 }),
      fakeRoom({
        id: "!dm-bob",
        name: "bob",
        named: false,
        members: ["@me:hippius.com", "@bob:hippius.com"],
        lastActive: 5,
      }),
      fakeRoom({ id: "!dm-carol", name: "carol", lastActive: 50 }),
      fakeRoom({ id: "!invite", name: "Invited", membership: "invite", lastActive: 1 }),
      fakeRoom({ id: "!space", name: "Space", type: "m.space" }),
      fakeRoom({ id: "!left", name: "Left", membership: "leave" }),
    ];
    const client = fakeClient(rooms, { "@carol:hippius.com": ["!dm-carol"] }, ["!zeta"]);

    const buckets = summariseRooms(client);

    expect(buckets.channels.map((r) => r.id)).toEqual(["!alpha", "!zeta"]);
    expect(buckets.dms.map((r) => r.id)).toEqual(["!dm-carol", "!dm-bob"]);
    expect(buckets.dms[0].dmUserId).toBe("@carol:hippius.com");
    expect(buckets.dms[1].dmUserId).toBe("@bob:hippius.com");
    expect(buckets.invites.map((r) => r.id)).toEqual(["!invite"]);
    expect(buckets.channels[1].muted).toBe(true);
    expect(buckets.channels[0]).toMatchObject({ unread: 3, highlight: 1, kind: "channel" });
  });

  it("excludes muted rooms from the total badge", () => {
    const rooms = [
      fakeRoom({ id: "!a", name: "a", unread: 2, highlight: 1 }),
      fakeRoom({ id: "!b", name: "b", unread: 7, highlight: 7 }),
    ];
    const buckets = summariseRooms(fakeClient(rooms, {}, ["!b"]));
    expect(totalUnread(buckets)).toEqual({ unread: 2, highlight: 1 });
  });

  it("reads m.direct into a room -> user map", () => {
    const client = fakeClient([], { "@x:hippius.com": ["!1", "!2"], "@y:hippius.com": ["!3"] });
    const map = directRoomMap(client);
    expect(map.get("!1")).toBe("@x:hippius.com");
    expect(map.get("!3")).toBe("@y:hippius.com");
    expect(map.size).toBe(3);
  });
});

describe("naming helpers", () => {
  it("labels channels with # and DMs by name", () => {
    expect(roomLabel({ kind: "channel", name: "general" })).toBe("#general");
    expect(roomLabel({ kind: "channel", name: "#already" })).toBe("#already");
    expect(roomLabel({ kind: "dm", name: "Bob" })).toBe("Bob");
  });

  it("slugifies channel names like Slack", () => {
    expect(slugifyChannelName("Product Design")).toBe("product-design");
    expect(slugifyChannelName("  ops / on-call!! ")).toBe("ops-on-call");
    expect(slugifyChannelName("---")).toBe("");
  });

  it("validates and completes user ids", () => {
    expect(isValidUserId("@alice:hippius.com")).toBe(true);
    expect(isValidUserId("alice")).toBe(false);
    expect(isValidUserId("@alice")).toBe(false);
    expect(normaliseUserId("alice", "hippius.com")).toBe("@alice:hippius.com");
    expect(normaliseUserId("@alice", "hippius.com")).toBe("@alice:hippius.com");
    expect(normaliseUserId("@alice:other.org", "hippius.com")).toBe("@alice:other.org");
  });
});
