import { describe, it, expect, vi } from "vitest";
import { renderHook, fireEvent } from "@testing-library/react";
import { isTypingTarget, shortcutAction, trashShortcutHint, useTrashShortcuts } from "../useTrashShortcuts";

vi.mock("@/app/lib/capture/shortcutLabel", () => ({ isMacPlatform: () => true }));

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("delete shortcuts", () => {
  it("are Finder's on a Mac", () => {
    expect(shortcutAction(key("Backspace", { metaKey: true }), true)).toBe("trash");
    expect(shortcutAction(key("Backspace", { metaKey: true, altKey: true }), true)).toBe("forever");
    expect(shortcutAction(key("Backspace"), true)).toBeNull();
    expect(shortcutAction(key("Delete"), true)).toBeNull();
  });

  it("are Delete and Shift+Delete elsewhere", () => {
    expect(shortcutAction(key("Delete"), false)).toBe("trash");
    expect(shortcutAction(key("Delete", { shiftKey: true }), false)).toBe("forever");
    expect(shortcutAction(key("Backspace", { ctrlKey: true }), false)).toBe("trash");
    expect(trashShortcutHint("forever", false)).toBe("Shift+Delete");
    expect(trashShortcutHint("trash", true)).toBe("⌘⌫");
  });

  it("fire on the window and never while typing", () => {
    const onTrash = vi.fn();
    const onForever = vi.fn();
    renderHook(() => useTrashShortcuts({ enabled: true, onTrash, onForever }));
    fireEvent.keyDown(window, { key: "Backspace", metaKey: true });
    fireEvent.keyDown(window, { key: "Backspace", metaKey: true, altKey: true });
    expect(onTrash).toHaveBeenCalledTimes(1);
    expect(onForever).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(isTypingTarget(input)).toBe(true);
    fireEvent.keyDown(input, { key: "Backspace", metaKey: true });
    expect(onTrash).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("do nothing while disabled", () => {
    const onTrash = vi.fn();
    renderHook(() => useTrashShortcuts({ enabled: false, onTrash, onForever: vi.fn() }));
    fireEvent.keyDown(window, { key: "Backspace", metaKey: true });
    expect(onTrash).not.toHaveBeenCalled();
  });
});
