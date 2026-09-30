import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, acceleratorKeys, enterKeyName, recorderKey } from "../shortcutLabel";

describe("acceleratorFromEvent", () => {
  const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) => ({
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("records the key by position, so Option+2 is not the symbol it types", () => {
    expect(acceleratorFromEvent(press("Digit2", { metaKey: true, shiftKey: true }))).toBe("Shift+Command+2");
    expect(acceleratorFromEvent(press("KeyC", { altKey: true, ctrlKey: true }))).toBe("Control+Alt+C");
  });

  it("waits while only modifiers are held", () => {
    expect(acceleratorFromEvent(press("ShiftLeft", { shiftKey: true }))).toBeNull();
    expect(acceleratorFromEvent(press("MetaLeft", { metaKey: true }))).toBeNull();
  });
});

describe("acceleratorKeys", () => {
  it("splits a shortcut into one keycap per key, modifiers first", () => {
    expect(acceleratorKeys("CommandOrControl+Shift+2", true)).toEqual(["⇧", "⌘", "2"]);
    expect(acceleratorKeys("CommandOrControl+Shift+2", false)).toEqual(["Ctrl", "Shift", "2"]);
    expect(acceleratorKeys("Alt+Control+KeyC", true)).toEqual(["⌃", "⌥", "C"]);
  });
});

describe("recorderKey", () => {
  const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("reports the modifiers held so far, so they can be drawn live", () => {
    expect(recorderKey(press("MetaLeft", { metaKey: true }))).toEqual({ kind: "modifiers", accelerator: "Command" });
    expect(recorderKey(press("ShiftRight", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "modifiers",
      accelerator: "Shift+Command",
    });
  });

  it("finishes on a letter, number or F key", () => {
    expect(recorderKey(press("Digit2", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "shortcut",
      accelerator: "Shift+Command+2",
    });
  });

  // Space and the backquote were silently ignored, leaving "Waiting..." up
  // with no hint why.
  it("names a key it cannot use rather than ignoring it", () => {
    expect(recorderKey(press("Space", { metaKey: true }))).toEqual({ kind: "unsupported" });
    expect(recorderKey(press("Backquote", { metaKey: true }))).toEqual({ kind: "unsupported" });
  });
});

describe("enterKeyName", () => {
  it("says Return on a Mac and Enter elsewhere", () => {
    expect(enterKeyName(true)).toBe("Return");
    expect(enterKeyName(false)).toBe("Enter");
  });
});
