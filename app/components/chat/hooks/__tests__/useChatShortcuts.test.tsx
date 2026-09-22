import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";

import {
  commandPaletteOpenAtom,
  rightPanelAtom,
  selectedRoomIdAtom,
} from "@/components/chat/chat-ui-atoms";
import {
  type ChatShortcutRooms,
  type ChatShortcutWorkspaces,
  isTypingTarget,
  nextRoomId,
  useChatShortcuts,
  workspaceForDigitKey,
} from "@/components/chat/hooks/useChatShortcuts";
import type { RoomSummary } from "@/lib/chat/rooms";

const room = (id: string, unread = 0) => ({ id, unread }) as RoomSummary;
const rooms = [room("a"), room("b", 2), room("c"), room("d", 1)];

describe("nextRoomId", () => {
  it("steps and wraps", () => {
    expect(nextRoomId(rooms, "a", 1, false)).toBe("b");
    expect(nextRoomId(rooms, "d", 1, false)).toBe("a");
    expect(nextRoomId(rooms, "a", -1, false)).toBe("d");
  });
  it("starts from the top when nothing is selected", () => {
    expect(nextRoomId(rooms, null, 1, false)).toBe("a");
    expect(nextRoomId(rooms, null, -1, false)).toBe("d");
  });
  it("skips read rooms in unread mode and returns null when none", () => {
    expect(nextRoomId(rooms, "a", 1, true)).toBe("b");
    expect(nextRoomId(rooms, "b", 1, true)).toBe("d");
    expect(nextRoomId(rooms, "d", 1, true)).toBe("b");
    expect(nextRoomId([room("x"), room("y")], "x", 1, true)).toBeNull();
  });
  it("handles a single room", () => {
    expect(nextRoomId([room("only")], "only", 1, false)).toBeNull();
    expect(nextRoomId([], "only", 1, false)).toBeNull();
  });
});

describe("workspaceForDigitKey", () => {
  const ids = ["!a", "!b", "!c"];
  it("maps 1..9 to rail positions", () => {
    expect(workspaceForDigitKey("1", ids)).toBe("!a");
    expect(workspaceForDigitKey("3", ids)).toBe("!c");
  });
  it("ignores digits past the end, 0, and non-digits", () => {
    expect(workspaceForDigitKey("4", ids)).toBeNull();
    expect(workspaceForDigitKey("0", ids)).toBeNull();
    expect(workspaceForDigitKey("k", ids)).toBeNull();
    expect(workspaceForDigitKey("1", [])).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("is true for form fields and contenteditable, false for the page", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(editable)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("useChatShortcuts (window keydown)", () => {
  function Host({
    rooms,
    workspaces,
  }: {
    rooms: ChatShortcutRooms;
    workspaces?: ChatShortcutWorkspaces;
  }) {
    useChatShortcuts(rooms, workspaces);
    return <textarea aria-label="composer" />;
  }

  function mount(workspaces?: ChatShortcutWorkspaces) {
    const store = createStore();
    const view = render(
      <Provider store={store}>
        <Host rooms={{ ordered: rooms }} workspaces={workspaces} />
      </Provider>,
    );
    return { store, view };
  }

  it("Cmd/Ctrl+K opens the palette, even from inside the composer", () => {
    const { store, view } = mount();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(store.get(commandPaletteOpenAtom)).toBe(true);
    act(() => store.set(commandPaletteOpenAtom, false));
    fireEvent.keyDown(view.getByLabelText("composer"), {
      key: "K",
      metaKey: true,
    });
    expect(store.get(commandPaletteOpenAtom)).toBe(true);
  });

  it("a bare k, or Shift/Alt+K, does nothing", () => {
    const { store } = mount();
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, altKey: true });
    expect(store.get(commandPaletteOpenAtom)).toBe(false);
  });

  it("Cmd/Ctrl+digit selects the workspace at that rail position", () => {
    const onSelect = vi.fn();
    mount({ ids: ["!a", "!b"], onSelect });
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(onSelect).toHaveBeenCalledWith("!b");
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("Alt+Down/Up walk the rooms; Alt+Shift jumps between unread ones", () => {
    const { store } = mount();
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    expect(store.get(selectedRoomIdAtom)).toBe("a");
    fireEvent.keyDown(window, {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
    });
    expect(store.get(selectedRoomIdAtom)).toBe("b");
    fireEvent.keyDown(window, { key: "ArrowUp", altKey: true });
    expect(store.get(selectedRoomIdAtom)).toBe("a");
  });

  it("Escape on the page closes the right panel but not while typing", () => {
    const { store, view } = mount();
    act(() => store.set(rightPanelAtom, { kind: "details", roomId: "!x" }));
    fireEvent.keyDown(view.getByLabelText("composer"), { key: "Escape" });
    expect(store.get(rightPanelAtom)).toEqual({
      kind: "details",
      roomId: "!x",
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(store.get(rightPanelAtom)).toBeNull();
  });

  it("unbinds on unmount", () => {
    const { store, view } = mount();
    view.unmount();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(store.get(commandPaletteOpenAtom)).toBe(false);
  });
});
