import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

// The GIF availability probe and the picker's pages go through Rust.
const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

// What the composer hands to the SDK layer. The real functions need a live
// client; the placeholder rule is the one desktop-only rule under test.
const sendText = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => undefined,
);
const editText = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => undefined,
);
vi.mock("@/lib/chat/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/compose")>();
  return {
    ...actual,
    sendText: (...args: unknown[]) => sendText(...args),
    editText: (...args: unknown[]) => editText(...args),
  };
});
vi.mock("@/components/chat/UserAvatar", () => ({
  default: () => <span data-testid="avatar" />,
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { default: Composer } = await import("@/components/chat/Composer");
const { GIFS_DISABLED_MESSAGE } = await import("@/lib/chat/gifs-api");
const { editingTargetAtom } = await import("@/components/chat/chat-ui-atoms");

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
  editText.mockClear();
  toast.error.mockReset();
  window.localStorage.clear();
  tauri.reset();
});

const GIF_PAGE = {
  kind: "page",
  results: [
    {
      id: "g1",
      title: "Cats",
      preview: {
        url: "https://media.example/g1/100w.gif",
        width: 200,
        height: 120,
      },
      full: {
        url: "https://media.example/g1/giphy.gif",
        width: 400,
        height: 240,
        size: 1000,
      },
      mp4: null,
    },
  ],
  next: null,
  attribution: "Powered by GIPHY",
};

describe("Composer slash commands on desktop", () => {
  it("/gif <query> opens the picker pre-filled with the query and sends no text", async () => {
    tauri.onInvoke("chat_gifs_featured", () => GIF_PAGE);
    tauri.onInvoke("chat_gifs_search", () => GIF_PAGE);
    render(
      <Provider store={createStore()}>
        <Composer
          client={client}
          room={room}
          events={[]}
          placeholder="Message #general"
        />
      </Provider>,
    );
    type("/gif cats");
    const search = await screen.findByRole("textbox", { name: "Search GIFs" });
    expect(search).toHaveValue("cats");
    expect(sendText).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    // The command is consumed, like every other successful slash command.
    expect(
      screen.getByRole("textbox", { name: "Message #general" }),
    ).toHaveValue("");
  });

  it("/gif on a deployment without GIFs toasts why instead of flashing a popover, and keeps the text", async () => {
    tauri.onInvoke("chat_gifs_featured", () => ({
      kind: "disabled",
      code: "gifs_not_configured",
    }));
    render(
      <Provider store={createStore()}>
        <Composer
          client={client}
          room={room}
          events={[]}
          placeholder="Message #general"
        />
      </Provider>,
    );
    type("/gif cats");
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(GIFS_DISABLED_MESSAGE),
    );
    expect(screen.queryByRole("textbox", { name: "Search GIFs" })).toBeNull();
    expect(sendText).not.toHaveBeenCalled();
    // The text stays so the user can edit rather than retype it.
    expect(
      screen.getByRole("textbox", { name: "Message #general" }),
    ).toHaveValue("/gif cats");
    // The button now says so too, without a click.
    expect(screen.getByRole("button", { name: "Insert GIF" })).toBeDisabled();
  });

  it("plain text still sends", async () => {
    render(
      <Composer
        client={client}
        room={room}
        events={[]}
        placeholder="Message #general"
      />,
    );
    type("hello");
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(sendText.mock.calls[0]?.[2]).toBe("hello");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

/** A thread's root message as the SDK exposes it: `threadRootId` is its own id. */
function threadRoot(id: string): MatrixEvent {
  return {
    getId: () => id,
    getSender: () => "@me:hippius.com",
    getContent: () => ({ msgtype: "m.text", body: "original root text" }),
    threadRootId: id,
    isThreadRoot: true,
  } as unknown as MatrixEvent;
}

describe("Composer edit scope", () => {
  // The room's main composer and a thread panel's composer are mounted at
  // once, and the thread root sits in both timelines. An edit begun in the
  // thread panel used to be picked up by the main composer as well, whose
  // next send replaced the root message instead of posting a new one.
  it("an edit begun in a thread panel never turns the main composer's send into an edit", async () => {
    const root = threadRoot("$root");
    const store = createStore();
    store.set(editingTargetAtom, {
      roomId: room.roomId,
      threadRootId: "$root",
      eventId: "$root",
    });
    render(
      <Provider store={store}>
        <Composer
          client={client}
          room={room}
          events={[root]}
          placeholder="Message #general"
        />
      </Provider>,
    );
    // Not in edit mode: no banner, the box is empty rather than the root's text.
    expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
    type("a brand new message");
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    expect(sendText.mock.calls[0]?.[2]).toBe("a brand new message");
    expect(editText).not.toHaveBeenCalled();
    // The thread panel's edit is still pending for its own composer.
    expect(store.get(editingTargetAtom)).toEqual({
      roomId: room.roomId,
      threadRootId: "$root",
      eventId: "$root",
    });
  });

  it("the composer the edit was begun in does edit", async () => {
    const root = threadRoot("$root");
    const store = createStore();
    store.set(editingTargetAtom, {
      roomId: room.roomId,
      threadRootId: "$root",
      eventId: "$root",
    });
    render(
      <Provider store={store}>
        <Composer
          client={client}
          room={room}
          threadRootId="$root"
          events={[root]}
          placeholder="Reply in thread"
        />
      </Provider>,
    );
    expect(screen.getByText("Editing message")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("original root text");
    type("corrected root text");
    await waitFor(() => expect(editText).toHaveBeenCalledTimes(1));
    expect(editText.mock.calls[0]?.[2]).toBe(root);
    expect(editText.mock.calls[0]?.[3]).toBe("corrected root text");
    expect(sendText).not.toHaveBeenCalled();
    expect(store.get(editingTargetAtom)).toBeNull();
  });

  it("an edit target from another room is ignored", () => {
    const store = createStore();
    store.set(editingTargetAtom, {
      roomId: "!other:hippius.com",
      threadRootId: null,
      eventId: "$root",
    });
    render(
      <Provider store={store}>
        <Composer
          client={client}
          room={room}
          events={[threadRoot("$root")]}
          placeholder="Message #general"
        />
      </Provider>,
    );
    expect(screen.queryByText("Editing message")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
});
