import { describe, expect, it } from "vitest";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

import { ATTACHMENT_BODY, classifyIncoming, HISTORY_WINDOW_MS } from "@/lib/chat/notifications";

const ME = "@me:hippius.com";
const BOB = "@bob:hippius.com";
const NOW = 1_700_000_000_000;

interface EventSpec {
  sender?: string;
  type?: string;
  body?: string | null;
  ts?: number;
  status?: string | null;
  redacted?: boolean;
  decryptionFailure?: boolean;
}

function fakeEvent(spec: EventSpec = {}): MatrixEvent {
  const content = spec.body === null ? { msgtype: "m.image", url: "mxc://x" } : { msgtype: "m.text", body: spec.body ?? "hello" };
  return {
    getSender: () => spec.sender ?? BOB,
    getType: () => spec.type ?? "m.room.message",
    getContent: () => content,
    getWireContent: () => content,
    getTs: () => spec.ts ?? NOW,
    status: spec.status ?? null,
    isRedacted: () => spec.redacted ?? false,
    isDecryptionFailure: () => spec.decryptionFailure ?? false,
    replacingEventId: () => undefined,
    getId: () => "$e",
  } as unknown as MatrixEvent;
}

function fakeRoom(id: string, opts: { named?: boolean; members?: string[] } = {}): Room {
  const members = opts.members ?? [ME, BOB, "@carol:hippius.com"];
  return {
    roomId: id,
    name: opts.named === false ? "bob" : "general",
    currentState: {
      getStateEvents: (type: string) =>
        type === "m.room.name" && opts.named !== false ? { getContent: () => ({ name: "general" }) } : null,
    },
    getDMInviter: () => undefined,
    getJoinedMembers: () => members.map((userId) => ({ userId, name: userId.slice(1).split(":")[0] })),
    getJoinedMemberCount: () => members.length,
    getMember: (userId: string) => (members.includes(userId) ? { userId, name: userId.slice(1).split(":")[0] } : null),
  } as unknown as Room;
}

function fakeClient(actions: { notify: boolean; highlight?: boolean } | null): MatrixClient {
  return {
    getUserId: () => ME,
    getPushActionsForEvent: () =>
      actions ? { notify: actions.notify, tweaks: { highlight: actions.highlight ?? false } } : null,
  } as unknown as MatrixClient;
}

const ctx = (openRoomId: string | null = null, direct = new Map<string, string>()) => ({ now: NOW, direct, openRoomId });

describe("classifyIncoming", () => {
  it("reports a channel message with the Matrix facts Rust decides on", () => {
    const report = classifyIncoming(fakeClient({ notify: true, highlight: true }), fakeRoom("!g"), fakeEvent({ body: "hey @me\nsecond line" }), ctx());
    expect(report).toEqual({
      roomId: "!g",
      roomName: "#general",
      senderName: "bob",
      body: "hey @me",
      isDirect: false,
      isMention: true,
      roomIsOpen: false,
    });
  });

  it("marks a DM (via m.direct or the two-member shape) and names it after the sender", () => {
    const viaDirect = classifyIncoming(
      fakeClient({ notify: true }),
      fakeRoom("!dm"),
      fakeEvent(),
      ctx(null, new Map([["!dm", BOB]])),
    );
    expect(viaDirect).toMatchObject({ isDirect: true, isMention: false, roomName: "bob" });

    const viaShape = classifyIncoming(
      fakeClient({ notify: true }),
      fakeRoom("!two", { named: false, members: [ME, BOB] }),
      fakeEvent(),
      ctx(),
    );
    expect(viaShape).toMatchObject({ isDirect: true, roomName: "bob" });
  });

  // It only reports facts: a plain channel message with notify=true is
  // still handed over (as not-a-mention) — Rust's policy drops it.
  it("does not pre-decide the mentions-only rule", () => {
    const report = classifyIncoming(fakeClient({ notify: true, highlight: false }), fakeRoom("!g"), fakeEvent(), ctx());
    expect(report).toMatchObject({ isDirect: false, isMention: false });
  });

  it("flags the open room from the UI context", () => {
    expect(classifyIncoming(fakeClient({ notify: true }), fakeRoom("!g"), fakeEvent(), ctx("!g"))?.roomIsOpen).toBe(true);
    expect(classifyIncoming(fakeClient({ notify: true }), fakeRoom("!g"), fakeEvent(), ctx("!other"))?.roomIsOpen).toBe(false);
  });

  it("uses a placeholder body for attachments", () => {
    expect(classifyIncoming(fakeClient({ notify: true }), fakeRoom("!g"), fakeEvent({ body: null }), ctx())?.body).toBe(ATTACHMENT_BODY);
  });

  it("returns null for anything the user cannot be told about", () => {
    const client = fakeClient({ notify: true, highlight: true });
    const room = fakeRoom("!g");
    // Our own message.
    expect(classifyIncoming(client, room, fakeEvent({ sender: ME }), ctx())).toBeNull();
    // Local echo still sending.
    expect(classifyIncoming(client, room, fakeEvent({ status: "sending" }), ctx())).toBeNull();
    // Not a message (a reaction, a membership change).
    expect(classifyIncoming(client, room, fakeEvent({ type: "m.reaction" }), ctx())).toBeNull();
    expect(classifyIncoming(client, room, fakeEvent({ type: "m.room.member" }), ctx())).toBeNull();
    // Still encrypted, or deleted.
    expect(classifyIncoming(client, room, fakeEvent({ decryptionFailure: true }), ctx())).toBeNull();
    expect(classifyIncoming(client, room, fakeEvent({ redacted: true }), ctx())).toBeNull();
    // History catching up (older than the window); just inside is fine.
    expect(classifyIncoming(client, room, fakeEvent({ ts: NOW - HISTORY_WINDOW_MS - 1 }), ctx())).toBeNull();
    expect(classifyIncoming(client, room, fakeEvent({ ts: NOW - HISTORY_WINDOW_MS + 1 }), ctx())).not.toBeNull();
    // Push rules (muted room, no matching rule) say nothing.
    expect(classifyIncoming(fakeClient({ notify: false }), room, fakeEvent(), ctx())).toBeNull();
    expect(classifyIncoming(fakeClient(null), room, fakeEvent(), ctx())).toBeNull();
  });
});
