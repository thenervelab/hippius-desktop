import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, formatAccelerator } from "../shortcutLabel";

describe("formatAccelerator", () => {
  it("shows a Mac shortcut in the system's own symbols and order", () => {
    expect(formatAccelerator("CommandOrControl+Shift+2", true)).toBe("⇧⌘2");
    expect(formatAccelerator("Command+Alt+Control+KeyC", true)).toBe("⌃⌥⌘C");
  });

  it("spells it out elsewhere", () => {
    expect(formatAccelerator("CommandOrControl+Shift+2", false)).toBe("Ctrl+Shift+2");
    expect(formatAccelerator("Alt+Shift+Digit7", false)).toBe("Alt+Shift+7");
  });
});

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
