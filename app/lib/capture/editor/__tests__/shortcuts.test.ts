import { describe, expect, it } from "vitest";
import { commandFor, TOOLS } from "../shortcuts";
import { isEditableImageName, offersImageEditor } from "../driveEntry";

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("editor keys", () => {
  it("gives every tool its own letter", () => {
    const letters = TOOLS.map((t) => t.key);
    expect(new Set(letters).size).toBe(letters.length);
    for (const t of TOOLS) expect(commandFor(key(t.key.toLowerCase()), true)).toEqual({ type: "tool", tool: t.id });
    expect(commandFor(key("A", { shiftKey: true }), true)).toBeNull();
  });

  it("uses Command on a Mac and Control elsewhere for undo, redo, save and copy", () => {
    expect(commandFor(key("z", { metaKey: true }), true)).toEqual({ type: "undo" });
    expect(commandFor(key("Z", { metaKey: true, shiftKey: true }), true)).toEqual({ type: "redo" });
    expect(commandFor(key("z", { ctrlKey: true }), true)).toBeNull();
    expect(commandFor(key("z", { ctrlKey: true }), false)).toEqual({ type: "undo" });
    expect(commandFor(key("y", { ctrlKey: true }), false)).toEqual({ type: "redo" });
    expect(commandFor(key("s", { metaKey: true }), true)).toEqual({ type: "save" });
    expect(commandFor(key("c", { metaKey: true, shiftKey: true }), true)).toEqual({ type: "copy" });
    // Cmd+A is not the arrow tool.
    expect(commandFor(key("a", { metaKey: true }), true)).toBeNull();
  });

  it("deletes, escapes, applies a crop and nudges", () => {
    expect(commandFor(key("Backspace"), true)).toEqual({ type: "delete" });
    expect(commandFor(key("Delete"), false)).toEqual({ type: "delete" });
    expect(commandFor(key("Escape"), true)).toEqual({ type: "escape" });
    expect(commandFor(key("Enter"), true)).toEqual({ type: "applyCrop" });
    expect(commandFor(key("ArrowLeft"), true)).toEqual({ type: "nudge", dx: -1, dy: 0 });
    expect(commandFor(key("ArrowDown", { shiftKey: true }), true)).toEqual({ type: "nudge", dx: 0, dy: 10 });
  });

  it("zooms with the platform's zoom keys, and a bare minus or zero is not a zoom", () => {
    expect(commandFor(key("=", { metaKey: true }), true)).toEqual({ type: "zoomIn" });
    expect(commandFor(key("+", { metaKey: true, shiftKey: true }), true)).toEqual({ type: "zoomIn" });
    expect(commandFor(key("-", { ctrlKey: true }), false)).toEqual({ type: "zoomOut" });
    expect(commandFor(key("0", { ctrlKey: true }), false)).toEqual({ type: "zoomFit" });
    expect(commandFor(key("0", { ctrlKey: true }), true)).toBeNull();
    expect(commandFor(key("-"), true)).toBeNull();
    expect(commandFor(key("0"), true)).toBeNull();
  });
});

describe("Drive's Edit image", () => {
  const row = { name: "Shot.png", isFolder: false, label: "Work", cloudOnly: false, memberDrive: false };

  // The reported gap: pictures in a remote folder could not be edited.
  it("is offered for a picture only on the server when the row has its file id", () => {
    expect(offersImageEditor({ ...row, cloudOnly: true, serverFileId: "ab12" }, true)).toBe(true);
    expect(offersImageEditor({ ...row, cloudOnly: true, serverFileId: "ab12", memberDrive: true }, true)).toBe(false);
  });

  it("is offered for a PNG or JPEG in an own drive on this computer", () => {
    expect(offersImageEditor(row, true)).toBe(true);
    expect(offersImageEditor({ ...row, name: "photo.JPEG" }, true)).toBe(true);
    expect(isEditableImageName("clip.mp4")).toBe(false);
  });

  it("is not offered for folders, cloud-only rows, shared drives, other files, or with capture off", () => {
    expect(offersImageEditor({ ...row, isFolder: true }, true)).toBe(false);
    expect(offersImageEditor({ ...row, cloudOnly: true }, true)).toBe(false);
    expect(offersImageEditor({ ...row, cloudOnly: true, serverFileId: "" }, true)).toBe(false);
    expect(offersImageEditor({ ...row, memberDrive: true }, true)).toBe(false);
    expect(offersImageEditor({ ...row, label: null }, true)).toBe(false);
    expect(offersImageEditor({ ...row, name: "anim.gif" }, true)).toBe(false);
    expect(offersImageEditor(row, false)).toBe(false);
  });
});
