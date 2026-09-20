import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MatrixClient, Room } from "matrix-js-sdk";

// What the composer hands to the SDK layer. The real functions need a live
// client; the placeholder rule is the one desktop-only rule under test.
const sendText = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("@/lib/chat/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/compose")>();
  return { ...actual, sendText: (...args: unknown[]) => sendText(...args) };
});
vi.mock("@/components/chat/UserAvatar", () => ({ default: () => <span data-testid="avatar" /> }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { default: Composer, GIF_UNAVAILABLE_MESSAGE } = await import("@/components/chat/Composer");

const client = {
  getUserId: () => "@me:hippius.com",
  sendTyping: async () => undefined,
} as unknown as MatrixClient;

const room = {
  roomId: "!r:hippius.com",
  getJoinedMembers: () => [],
  getMember: () => null,
  findEventById: () => undefined,
} as unknown as Room;

function type(value: string) {
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value } });
  fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
}

beforeEach(() => {
  sendText.mockClear();
  toast.error.mockReset();
  window.localStorage.clear();
});

describe("Composer slash commands on desktop", () => {
  it("/gif is recognised but explains the picker is not here yet, and sends nothing", async () => {
    render(<Composer client={client} room={room} events={[]} placeholder="Message #general" />);
    type("/gif cats");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(GIF_UNAVAILABLE_MESSAGE));
    expect(sendText).not.toHaveBeenCalled();
    // The text stays so the user can edit rather than retype it.
    expect(screen.getByRole("textbox")).toHaveValue("/gif cats");
  });

  it("plain text still sends", async () => {
    render(<Composer client={client} room={room} events={[]} placeholder="Message #general" />);
    type("hello");
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(sendText.mock.calls[0]?.[2]).toBe("hello");
    expect(toast.error).not.toHaveBeenCalled();
  });
});
