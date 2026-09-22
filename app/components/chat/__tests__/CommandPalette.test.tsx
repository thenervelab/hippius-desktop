import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";

import {
  commandPaletteOpenAtom,
  createChannelOpenAtom,
  newMessageOpenAtom,
  rightPanelAtom,
  selectedRoomIdAtom,
} from "@/components/chat/chat-ui-atoms";
import type { KnownUser, RoomSummary } from "@/lib/chat/rooms";

const room = (id: string, name: string, extra: Partial<RoomSummary> = {}) =>
  ({
    id,
    name,
    kind: "channel",
    topic: null,
    unread: 0,
    highlight: 0,
    muted: false,
    isPublic: true,
    dmUserId: null,
    lastActiveTs: 0,
    avatarMxc: null,
    ...extra,
  }) as RoomSummary;

const general = room("!general", "general", { lastActiveTs: 10 });
const backend = room("!backend", "backend", {
  topic: "Rust and Postgres",
  lastActiveTs: 20,
  isPublic: false,
});
const dmBob = room("!dm-bob", "Bob", {
  kind: "dm",
  dmUserId: "@bob:hippius.com",
  lastActiveTs: 5,
});
const alice: KnownUser = {
  userId: "@alice:hippius.com",
  displayName: "Alice",
  avatarMxc: null,
};
const bob: KnownUser = {
  userId: "@bob:hippius.com",
  displayName: "Bob",
  avatarMxc: null,
};

const openDirectRoom = vi.fn();
vi.mock("@/lib/chat/rooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/rooms")>()),
  knownUsers: () => [alice, bob],
  openDirectRoom: (...args: unknown[]) => openDirectRoom(...args),
}));
vi.mock("@/components/chat/hooks/useRoomList", () => ({
  useRoomList: () => ({
    channels: [general, backend],
    dms: [dmBob],
    invites: [],
    unread: 0,
    highlight: 0,
  }),
}));
vi.mock("@/components/chat/UserAvatar", () => ({
  default: () => <span data-testid="avatar" />,
}));
const toast = { error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const {
  default: CommandPalette,
  rememberRecentRoom,
  resetRecentRoomsForTests,
} = await import("@/components/chat/CommandPalette");

const client = {
  getUserId: () => "@me:hippius.com",
} as unknown as MatrixClient;

function mount() {
  const store = createStore();
  store.set(commandPaletteOpenAtom, true);
  store.set(rightPanelAtom, { kind: "details", roomId: "!x" });
  render(
    <Provider store={store}>
      <CommandPalette client={client} />
    </Provider>,
  );
  return store;
}

const optionNames = () =>
  screen.getAllByRole("option").map((o) => o.textContent ?? "");
const input = () => screen.getByRole("combobox");

describe("CommandPalette", () => {
  beforeEach(() => {
    resetRecentRoomsForTests();
    openDirectRoom.mockReset();
    toast.error.mockReset();
  });

  it("lists rooms (recent first), people without a DM yet, and the two actions", () => {
    rememberRecentRoom("!general");
    mount();
    const names = optionNames();
    // general was opened most recently so it beats backend's newer activity.
    expect(names[0]).toContain("general");
    expect(names[1]).toContain("backend");
    expect(names[2]).toContain("Bob");
    // Bob already has a DM row, so only Alice is offered as a new person.
    expect(names.filter((n) => n.includes("@alice:hippius.com"))).toHaveLength(
      1,
    );
    expect(names.some((n) => n.includes("@bob:hippius.com"))).toBe(false);
    expect(names.at(-2)).toContain("Create a new channel");
    expect(names.at(-1)).toContain("Start a new message");
  });

  it("filters by name and topic and ignores a leading #", () => {
    mount();
    fireEvent.change(input(), { target: { value: "#postgres" } });
    expect(optionNames()).toEqual([expect.stringContaining("backend")]);
    fireEvent.change(input(), { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("ArrowDown + Enter opens the highlighted room, closes the right panel and the palette", async () => {
    const store = mount();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(store.get(selectedRoomIdAtom)).toBe("!general"));
    expect(store.get(rightPanelAtom)).toBeNull();
    expect(store.get(commandPaletteOpenAtom)).toBe(false);
  });

  it("ArrowUp from the top wraps to the last item", () => {
    mount();
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    const selected = screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("Start a new message");
  });

  it("picking a person opens (or creates) the DM through openDirectRoom", async () => {
    openDirectRoom.mockResolvedValue("!dm-alice");
    const store = mount();
    fireEvent.change(input(), { target: { value: "alice" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
    });
    expect(openDirectRoom).toHaveBeenCalledWith(client, "@alice:hippius.com");
    await waitFor(() =>
      expect(store.get(selectedRoomIdAtom)).toBe("!dm-alice"),
    );
    expect(store.get(commandPaletteOpenAtom)).toBe(false);
  });

  it("a failed DM open toasts and keeps the palette up", async () => {
    openDirectRoom.mockRejectedValue(new Error("M_FORBIDDEN"));
    const store = mount();
    fireEvent.change(input(), { target: { value: "alice" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("M_FORBIDDEN"),
    );
    expect(store.get(commandPaletteOpenAtom)).toBe(true);
    expect(store.get(selectedRoomIdAtom)).toBeNull();
  });

  it("actions hand off to the create-channel / new-message dialogs", () => {
    const store = mount();
    fireEvent.click(
      screen.getByRole("option", { name: /Create a new channel/ }),
    );
    expect(store.get(createChannelOpenAtom)).toBe(true);
    expect(store.get(commandPaletteOpenAtom)).toBe(false);

    act(() => store.set(commandPaletteOpenAtom, true));
    fireEvent.click(
      screen.getByRole("option", { name: /Start a new message/ }),
    );
    expect(store.get(newMessageOpenAtom)).toBe(true);
  });

  it("reopening resets the query", () => {
    const store = mount();
    fireEvent.change(input(), { target: { value: "back" } });
    act(() => store.set(commandPaletteOpenAtom, false));
    act(() => store.set(commandPaletteOpenAtom, true));
    expect((input() as HTMLInputElement).value).toBe("");
  });
});
