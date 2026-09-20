import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

import { jumpToEventAtom, rightPanelAtom, selectedRoomIdAtom } from "@/components/chat/chat-ui-atoms";
import { eventPermalink } from "@/lib/chat/rooms";

// The card itself is covered in AttachmentView.test.tsx; here only whether
// it is rendered, and whether a body is rendered above it.
vi.mock("@/components/chat/AttachmentView", () => ({
  default: ({ attachment }: { attachment: { name: string } }) => <div data-testid="attachment">{attachment.name}</div>,
}));
// Avatars fetch media; not the point here.
vi.mock("@/components/chat/UserAvatar", () => ({ default: () => <span data-testid="avatar" /> }));

const { default: MessageRow } = await import("@/components/chat/MessageRow");

const ME = "@me:hippius.com";
const OTHER_ROOM = {
  roomId: "!other:hippius.com",
  getCanonicalAlias: () => "#general:hippius.com",
  getAltAliases: () => [],
} as unknown as Room;
const client = {
  getUserId: () => ME,
  getRoom: (id: string) => (id === room.roomId ? room : id === OTHER_ROOM.roomId ? OTHER_ROOM : null),
  getRooms: () => [room, OTHER_ROOM],
} as unknown as MatrixClient;

const room = {
  roomId: "!r:hippius.com",
  getCanonicalAlias: () => null,
  getAltAliases: () => [],
  getMember: (id: string) => ({ name: id.slice(1).split(":")[0], getMxcAvatarUrl: () => null }),
  getUnfilteredTimelineSet: () => ({ relations: { getChildEventsForEvent: () => null } }),
  getUsersReadUpTo: () => [],
  currentState: { maySendRedactionForEvent: () => false },
  getAccountData: () => undefined,
} as unknown as Room;

function fakeEvent(content: Record<string, unknown>, sender = "@ada:hippius.com"): MatrixEvent {
  return {
    getId: () => "$e1",
    getTxnId: () => undefined,
    getType: () => "m.room.message",
    getSender: () => sender,
    getTs: () => new Date(2026, 8, 18, 10, 0, 0).getTime(),
    getContent: () => content,
    getPrevContent: () => ({}),
    getWireContent: () => content,
    isRelation: () => false,
    threadRootId: undefined,
    isThreadRoot: false,
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    isBeingDecrypted: () => false,
    replacingEventId: () => undefined,
    getThread: () => null,
    status: null,
  } as unknown as MatrixEvent;
}

// `filename` is the file's name; `body` is the caption, which clients
// that have no caption fill with the filename again (that is the case the
// rule exists for).
const file = {
  msgtype: "m.file",
  filename: "report.pdf",
  body: "report.pdf",
  info: { mimetype: "application/pdf", size: 123 },
  url: "mxc://hippius.com/report",
};

function renderRow(event: MatrixEvent) {
  return render(<MessageRow client={client} room={room} event={event} groupStart tick={0} />);
}

describe("MessageRow attachment caption", () => {
  it("shows only the card when the body is just the filename", () => {
    renderRow(fakeEvent(file));
    expect(screen.getByTestId("attachment")).toHaveTextContent("report.pdf");
    // The filename is on the card; repeating it as message text above is noise.
    expect(screen.getAllByText("report.pdf")).toHaveLength(1);
  });

  it("shows the body above the card when it is a real caption", () => {
    renderRow(fakeEvent({ ...file, body: "Q3 numbers, see page 4" }));
    expect(screen.getByTestId("attachment")).toHaveTextContent("report.pdf");
    expect(screen.getByText("Q3 numbers, see page 4")).toBeInTheDocument();
  });

  it("a text message without attachment always renders its body", () => {
    renderRow(fakeEvent({ msgtype: "m.text", body: "hello there" }));
    expect(screen.queryByTestId("attachment")).not.toBeInTheDocument();
    expect(screen.getByText("hello there")).toBeInTheDocument();
  });
});

// A link in a message is parsed from its href on click. Our own "Copy link"
// percent-encodes the room and event ids; matching the raw href let those
// links fall through to the webview's default navigation instead of
// jumping, and only same-room links were ever routed.
describe("MessageRow matrix.to links", () => {
  function renderLink(href: string) {
    const store = createStore();
    const event = fakeEvent({
      msgtype: "m.text",
      body: "see this",
      format: "org.matrix.custom.html",
      formatted_body: `<a href="${href}">see this</a>`,
    });
    render(
      <Provider store={store}>
        <MessageRow client={client} room={room} event={event} groupStart tick={0} />
      </Provider>,
    );
    const anchor = screen.getByText("see this").closest("a")!;
    const click = fireEvent.click(anchor);
    return { store, defaultPrevented: !click };
  }

  it("jumps to the message a percent-encoded permalink of this room names", () => {
    const { store, defaultPrevented } = renderLink(eventPermalink(room.roomId, "$target"));
    expect(defaultPrevented).toBe(true);
    expect(store.get(jumpToEventAtom)).toEqual({ roomId: room.roomId, eventId: "$target" });
    expect(store.get(selectedRoomIdAtom)).toBeNull();
  });

  it("switches to the other room first when the permalink names it by alias", () => {
    const { store } = renderLink("https://matrix.to/#/%23general%3Ahippius.com/%24t2?via=hippius.com");
    expect(store.get(selectedRoomIdAtom)).toBe(OTHER_ROOM.roomId);
    expect(store.get(jumpToEventAtom)).toEqual({ roomId: OTHER_ROOM.roomId, eventId: "$t2" });
  });

  it("opens a percent-encoded mention in the member panel", () => {
    const { store } = renderLink("https://matrix.to/#/%40ada%3Ahippius.com");
    expect(store.get(rightPanelAtom)).toEqual({ kind: "member", roomId: room.roomId, userId: "@ada:hippius.com" });
  });

  it("does not navigate the webview for a room this account is not in", () => {
    const { store, defaultPrevented } = renderLink("https://matrix.to/#/!stranger:elsewhere.org/$x");
    expect(defaultPrevented).toBe(true);
    expect(store.get(jumpToEventAtom)).toBeNull();
    expect(store.get(selectedRoomIdAtom)).toBeNull();
  });

  // The sanitiser keeps `matrix:` hrefs as internal navigation (no
  // target="_blank"); left unrouted, the default action would navigate the
  // app window to the URI.
  it("routes a matrix: URI permalink like its matrix.to form, with the default prevented", () => {
    const { store, defaultPrevented } = renderLink(
      `matrix:roomid/${encodeURIComponent(room.roomId.slice(1))}/e/target?via=hippius.com`,
    );
    expect(defaultPrevented).toBe(true);
    expect(store.get(jumpToEventAtom)).toEqual({ roomId: room.roomId, eventId: "$target" });
  });

  it("routes a matrix: URI mention to the member panel, with the default prevented", () => {
    const { store, defaultPrevented } = renderLink("matrix:u/ada%3Ahippius.com");
    expect(defaultPrevented).toBe(true);
    expect(store.get(rightPanelAtom)).toEqual({ kind: "member", roomId: room.roomId, userId: "@ada:hippius.com" });
  });
});
