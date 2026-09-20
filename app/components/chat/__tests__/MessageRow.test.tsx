import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

// The card itself is covered in AttachmentView.test.tsx; here only whether
// it is rendered, and whether a body is rendered above it.
vi.mock("@/components/chat/AttachmentView", () => ({
  default: ({ attachment }: { attachment: { name: string } }) => <div data-testid="attachment">{attachment.name}</div>,
}));
// Avatars fetch media; not the point here.
vi.mock("@/components/chat/UserAvatar", () => ({ default: () => <span data-testid="avatar" /> }));

const { default: MessageRow } = await import("@/components/chat/MessageRow");

const ME = "@me:hippius.com";
const client = { getUserId: () => ME } as unknown as MatrixClient;

const room = {
  roomId: "!r:hippius.com",
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
