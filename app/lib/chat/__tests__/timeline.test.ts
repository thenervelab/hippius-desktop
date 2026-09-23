import { describe, expect, it } from "vitest";
import type { MatrixEvent, Room } from "matrix-js-sdk";

import {
  GROUP_WINDOW_MS,
  attachmentCaption,
  attachmentOf,
  buildTimelineItems,
  formatDayLabel,
  isRenderable,
  messageBody,
  stateEventText,
} from "@/lib/chat/timeline";

interface FakeEventSpec {
  id: string;
  type?: string;
  sender: string;
  ts: number;
  content?: Record<string, unknown>;
  prevContent?: Record<string, unknown>;
  stateKey?: string;
  relation?: { rel_type?: string; event_id?: string; "m.in_reply_to"?: { event_id: string } };
  threadRootId?: string;
  isThreadRoot?: boolean;
  redacted?: boolean;
  replacedBy?: string;
}

function fakeEvent(spec: FakeEventSpec): MatrixEvent {
  const content = spec.content ?? { msgtype: "m.text", body: `hello from ${spec.sender}` };
  return {
    getId: () => spec.id,
    getTxnId: () => undefined,
    getType: () => spec.type ?? "m.room.message",
    getSender: () => spec.sender,
    getTs: () => spec.ts,
    getContent: () => content,
    getPrevContent: () => spec.prevContent ?? {},
    getStateKey: () => spec.stateKey,
    getWireContent: () => ({ ...content, "m.relates_to": spec.relation }),
    isRelation: (relType?: string) => (spec.relation?.rel_type ? !relType || spec.relation.rel_type === relType : false),
    threadRootId: spec.threadRootId,
    isThreadRoot: spec.isThreadRoot ?? false,
    isRedacted: () => spec.redacted ?? false,
    isDecryptionFailure: () => false,
    replacingEventId: () => spec.replacedBy,
    status: null,
  } as unknown as MatrixEvent;
}

const room = {
  roomId: "!r:hippius.com",
  getMember: (id: string) => ({ name: id.slice(1).split(":")[0] }),
} as unknown as Room;

const T0 = new Date(2026, 8, 18, 10, 0, 0).getTime(); // local noon-ish, fixed

describe("timeline grouping", () => {
  it("groups consecutive messages from one sender inside the window and starts a day separator", () => {
    const events = [
      fakeEvent({ id: "$1", sender: "@alice:hippius.com", ts: T0 }),
      fakeEvent({ id: "$2", sender: "@alice:hippius.com", ts: T0 + 60_000 }),
      fakeEvent({ id: "$3", sender: "@bob:hippius.com", ts: T0 + 90_000 }),
      fakeEvent({ id: "$4", sender: "@bob:hippius.com", ts: T0 + 90_000 + GROUP_WINDOW_MS + 1 }),
    ];
    const items = buildTimelineItems(room, events);
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "message", "message", "message"]);
    const starts = items.filter((i) => i.kind === "message").map((i) => (i.kind === "message" ? i.groupStart : null));
    expect(starts).toEqual([true, false, true, true]);
  });

  it("inserts a day separator when the date changes", () => {
    const events = [
      fakeEvent({ id: "$1", sender: "@alice:hippius.com", ts: T0 }),
      fakeEvent({ id: "$2", sender: "@alice:hippius.com", ts: T0 + 86_400_000 }),
    ];
    const items = buildTimelineItems(room, events);
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "day", "message"]);
    // a new day also restarts the group
    expect(items[3]).toMatchObject({ kind: "message", groupStart: true });
  });

  it("draws the New line after the read marker, skipping our own messages", () => {
    const events = [
      fakeEvent({ id: "$1", sender: "@alice:hippius.com", ts: T0 }),
      fakeEvent({ id: "$2", sender: "@me:hippius.com", ts: T0 + 1000 }),
      fakeEvent({ id: "$3", sender: "@bob:hippius.com", ts: T0 + 2000 }),
    ];
    const items = buildTimelineItems(room, events, { readMarkerEventId: "$1", myUserId: "@me:hippius.com" });
    expect(items.map((i) => i.kind)).toEqual(["day", "message", "message", "new-line", "message"]);
  });

  it("draws no New line when the marker is outside the loaded window", () => {
    const events = [fakeEvent({ id: "$1", sender: "@alice:hippius.com", ts: T0 })];
    const items = buildTimelineItems(room, events, { readMarkerEventId: "$older", myUserId: "@me:hippius.com" });
    expect(items.some((i) => i.kind === "new-line")).toBe(false);
  });

  it("hides edits, reactions and thread replies but keeps thread roots", () => {
    expect(isRenderable(fakeEvent({ id: "$e", sender: "@a:x", ts: T0, relation: { rel_type: "m.replace", event_id: "$1" } }))).toBe(false);
    expect(isRenderable(fakeEvent({ id: "$r", sender: "@a:x", ts: T0, type: "m.reaction", relation: { rel_type: "m.annotation", event_id: "$1" } }))).toBe(false);
    expect(isRenderable(fakeEvent({ id: "$t", sender: "@a:x", ts: T0, threadRootId: "$1", relation: { rel_type: "m.thread", event_id: "$1" } }))).toBe(false);
    expect(isRenderable(fakeEvent({ id: "$1", sender: "@a:x", ts: T0, threadRootId: "$1", isThreadRoot: true }))).toBe(true);
  });

  it("renders membership changes as readable state lines", () => {
    const join = fakeEvent({
      id: "$j",
      sender: "@bob:hippius.com",
      ts: T0,
      type: "m.room.member",
      stateKey: "@bob:hippius.com",
      content: { membership: "join", displayname: "Bob" },
      prevContent: { membership: "invite" },
    });
    expect(stateEventText(room, join)).toBe("Bob joined");
    const rename = fakeEvent({
      id: "$n",
      sender: "@bob:hippius.com",
      ts: T0,
      type: "m.room.member",
      stateKey: "@bob:hippius.com",
      content: { membership: "join", displayname: "Robert" },
      prevContent: { membership: "join", displayname: "Bob" },
    });
    expect(stateEventText(room, rename)).toBe("Bob is now Robert");
    const avatarOnly = fakeEvent({
      id: "$a",
      sender: "@bob:hippius.com",
      ts: T0,
      type: "m.room.member",
      stateKey: "@bob:hippius.com",
      content: { membership: "join", displayname: "Bob", avatar_url: "mxc://x/1" },
      prevContent: { membership: "join", displayname: "Bob" },
    });
    expect(stateEventText(room, avatarOnly)).toBe("Bob changed their avatar");
  });
});

describe("message body and attachments", () => {
  it("flags edits, emotes and reply targets", () => {
    const edited = fakeEvent({ id: "$1", sender: "@a:x", ts: T0, replacedBy: "$2" });
    expect(messageBody(edited).edited).toBe(true);
    const emote = fakeEvent({ id: "$3", sender: "@a:x", ts: T0, content: { msgtype: "m.emote", body: "waves" } });
    expect(messageBody(emote).emote).toBe(true);
    const reply = fakeEvent({ id: "$4", sender: "@a:x", ts: T0, relation: { "m.in_reply_to": { event_id: "$0" } } });
    expect(messageBody(reply).replyToId).toBe("$0");
    const threadReply = fakeEvent({
      id: "$5",
      sender: "@a:x",
      ts: T0,
      relation: { rel_type: "m.thread", event_id: "$0", "m.in_reply_to": { event_id: "$0" } },
    });
    expect(messageBody(threadReply).replyToId).toBeNull();
  });

  it("extracts encrypted and plain attachments", () => {
    const plain = fakeEvent({
      id: "$p",
      sender: "@a:x",
      ts: T0,
      content: { msgtype: "m.image", body: "cat.png", url: "mxc://hippius.com/abc", info: { mimetype: "image/png", size: 1234, w: 10, h: 20 } },
    });
    expect(attachmentOf(plain)).toMatchObject({ msgtype: "m.image", name: "cat.png", url: "mxc://hippius.com/abc", size: 1234, width: 10, height: 20, file: null });
    const encrypted = fakeEvent({
      id: "$e",
      sender: "@a:x",
      ts: T0,
      content: { msgtype: "m.file", body: "doc.pdf", file: { url: "mxc://hippius.com/enc", v: "v2" }, info: { mimetype: "application/pdf" } },
    });
    expect(attachmentOf(encrypted)).toMatchObject({ msgtype: "m.file", url: null, file: { url: "mxc://hippius.com/enc" } });
    expect(attachmentOf(fakeEvent({ id: "$t", sender: "@a:x", ts: T0 }))).toBeNull();
  });

  it("flags GIFs: image/gif images and videos carrying the GIF marker, nothing else", () => {
    const at = (content: Record<string, unknown>) => attachmentOf(fakeEvent({ id: "$g", sender: "@a:x", ts: T0, content }));
    expect(at({ msgtype: "m.image", body: "a.gif", file: { url: "mxc://x/a", v: "v2" }, info: { mimetype: "image/gif" } })?.gif).toBe(true);
    expect(at({ msgtype: "m.image", body: "a.png", file: { url: "mxc://x/a", v: "v2" }, info: { mimetype: "image/png" } })?.gif).toBe(false);
    expect(at({ msgtype: "m.video", body: "a.mp4", file: { url: "mxc://x/a", v: "v2" }, info: { mimetype: "video/mp4" }, "com.hippius.chat.gif": true })?.gif).toBe(true);
    expect(at({ msgtype: "m.video", body: "a.mp4", file: { url: "mxc://x/a", v: "v2" }, info: { mimetype: "video/mp4" } })?.gif).toBe(false);
  });

  it("shows a caption only when the body is not just the filename", () => {
    const at = (content: Record<string, unknown>) => attachmentOf(fakeEvent({ id: "$c", sender: "@a:x", ts: T0, content }))!;
    const bare = at({ msgtype: "m.file", body: "report.pdf", filename: "report.pdf", url: "mxc://x/a", info: {} });
    expect(attachmentCaption("report.pdf", bare)).toBeNull();
    expect(attachmentCaption("report.pdf\n", bare)).toBeNull();
    expect(attachmentCaption("", bare)).toBeNull();
    expect(attachmentCaption("Q3 numbers, see p.4", bare)).toBe("Q3 numbers, see p.4");
    // No `filename` key: the body IS the name, so still no caption.
    const legacy = at({ msgtype: "m.image", body: "cat.png", url: "mxc://x/b", info: {} });
    expect(attachmentCaption("cat.png", legacy)).toBeNull();
  });

  it("labels today and yesterday", () => {
    const now = new Date(2026, 8, 18, 15, 0).getTime();
    expect(formatDayLabel(now - 3600_000, now)).toBe("Today");
    expect(formatDayLabel(now - 86_400_000, now)).toBe("Yesterday");
    expect(formatDayLabel(now - 3 * 86_400_000, now)).not.toBe("Yesterday");
  });
});
