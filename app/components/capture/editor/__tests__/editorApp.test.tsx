import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useEffect, type ReactNode } from "react";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock("@/app/lib/utils/isMacPlatform", () => ({ isMacPlatform: () => platform.mac }));

// The canvas needs a real 2D context; here it is a stand-in that makes one
// change when asked, reports a fitted zoom, and shows what the editor hands
// it (the tool, the zoom, the selection bar).
vi.mock("../EditorCanvas", () => ({
  default: function FakeCanvas(props: {
    tool: string;
    zoom: number | null;
    selectionBar: ReactNode;
    onScale: (z: number) => void;
    onCommit: (doc: unknown, sel: string | null) => void;
  }) {
    const { onScale } = props;
    useEffect(() => onScale(0.5), [onScale]);
    return (
      <div>
        <span data-testid="canvas-tool">{props.tool}</span>
        <span data-testid="canvas-zoom">{props.zoom === null ? "fit" : String(props.zoom)}</span>
        <button
          type="button"
          onClick={() =>
            props.onCommit({ annotations: [{ id: "s1", kind: "step", at: { x: 1, y: 1 }, n: 1, color: "#FF3B30", size: 20 }], crop: null }, "s1")
          }
        >
          fake draw
        </button>
        {props.selectionBar}
      </div>
    );
  },
}));

const exportPng = vi.hoisted(() => vi.fn(async () => new Uint8Array([137, 80, 78, 71])));
vi.mock("@/app/lib/capture/editor/render", async (orig) => ({ ...(await orig<object>()), exportPng }));

import EditorApp from "../EditorApp";
import type { EditorContext } from "@/app/lib/tauri/captureEditor";

const CONTEXT: EditorContext = {
  session: 42,
  fileName: "Screenshot 2026-10-05 at 10.00.00.png",
  driveName: "Work",
  mime: "image/png",
  saveKind: "inDrive",
  saveNote: "Saving replaces the file in your drive.",
  copyNote: 'Adds "Screenshot 2026-10-05 at 10.00.00 (edited).png" next to the original. The original, and any link to it, stay as they are.',
  replaceNote: "Overwrites Screenshot 2026-10-05 at 10.00.00.png. Its public link will show the old image until it is shared again.",
  hasPublicLink: true,
  savePreference: "ask",
};
const OUTCOME = { title: "Saved a copy", message: "Saved as \"x (edited).png\" next to the original.", fileName: "x (edited).png", offerLink: true };

const calls = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd);
let onClose: ReturnType<typeof vi.fn>;

function withContext(change: Partial<EditorContext>) {
  tauri.onInvoke("capture_editor_context", () => ({ ...CONTEXT, ...change }));
}

beforeEach(() => {
  tauri.reset();
  withContext({});
  tauri.onInvoke("capture_editor_image", () => new ArrayBuffer(8));
  tauri.onInvoke("capture_editor_close", () => null);
  tauri.onInvoke("capture_editor_save", () => OUTCOME);
  tauri.onInvoke("capture_editor_copy", () => null);
  tauri.onInvoke("capture_editor_set_save_preference", () => null);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 800, height: 500, close() {} })),
  );
  exportPng.mockClear();
  onClose = vi.fn();
  platform.mac = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open() {
  render(<EditorApp onClose={onClose} />);
  return screen.findByRole("toolbar", { name: "Tools" });
}

/** The editor layer itself, where its keys are handled. */
const layer = () => screen.getByRole("dialog", { name: `Edit ${CONTEXT.fileName}` });
const draw = () => fireEvent.click(screen.getByRole("button", { name: "fake draw" }));

describe("screenshot editor layout", () => {
  it("shows a skeleton until the picture has loaded, then Close, the file's name, the tools, Copy image and Save", async () => {
    render(<EditorApp onClose={onClose} />);
    expect(screen.getByTestId("editor-skeleton")).toBeInTheDocument();
    await screen.findByRole("toolbar", { name: "Tools" });
    expect(screen.queryByTestId("editor-skeleton")).not.toBeInTheDocument();
    expect(layer()).toBeInTheDocument();
    expect(screen.getByText(CONTEXT.fileName)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close (Esc)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save copy" })).toBeDisabled();
  });

  it("keeps Close, the name, Copy image and Save in one top bar, with the tools on their own row below it", async () => {
    const toolbar = await open();
    const bar = screen.getByTestId("editor-top-bar");
    expect(within(bar).getByRole("button", { name: "Close (Esc)" })).toBeInTheDocument();
    expect(within(bar).getByText(CONTEXT.fileName)).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Copy image" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Save copy" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "More ways to save" })).toBeInTheDocument();
    // The toolbar used to be absolutely centred over the bar, where it
    // covered Copy image and Save on a wide window. It has its own row now.
    expect(bar).not.toContainElement(toolbar);
    expect(screen.getByTestId("editor-tools-row")).toContainElement(toolbar);
    // The actions never shrink; the name truncates first.
    expect(screen.getByTestId("editor-save-actions").className).toContain("shrink-0");
  });

  it("leaves room for the macOS traffic lights, and only on macOS", async () => {
    await open();
    expect(screen.getByTestId("editor-top-bar").className).toContain("pl-[calc(80px*var(--zoom-inverse,1))]");
  });

  it("does not inset the bar for traffic lights elsewhere", async () => {
    platform.mac = false;
    await open();
    const bar = screen.getByTestId("editor-top-bar");
    expect(bar.className).not.toContain("80px");
    expect(bar.className).toContain("pl-[12px]");
  });

  it("drags the window from the bar's empty space, never from a button", async () => {
    await open();
    const bar = screen.getByTestId("editor-top-bar");
    expect(bar).toHaveAttribute("data-tauri-drag-region");
    for (const button of within(bar).getAllByRole("button")) {
      expect(button).not.toHaveAttribute("data-tauri-drag-region");
    }
  });

  it("has every tool in the one toolbar, each named with its key, and fills the active one with the brand blue", async () => {
    const toolbar = await open();
    for (const name of [
      "Select and move (V)",
      "Crop (K)",
      "Arrow (A)",
      "Rectangle (R)",
      "Ellipse (E)",
      "Line (L)",
      "Text (T)",
      "Highlighter (M)",
      "Numbered step (C)",
      "Blur (B)",
      "Pixelate (P)",
    ]) {
      const button = within(toolbar).getByRole("button", { name });
      expect(button).toHaveAttribute("title", name);
    }
    expect(within(toolbar).getByRole("button", { name: /Colour and thickness/ })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Undo" })).toBeInTheDocument();

    const arrow = within(toolbar).getByRole("button", { name: "Arrow (A)" });
    expect(arrow).toHaveAttribute("aria-pressed", "true");
    expect(arrow.className).toContain("bg-primary-50");
    fireEvent.click(within(toolbar).getByRole("button", { name: "Rectangle (R)" }));
    expect(within(toolbar).getByRole("button", { name: "Rectangle (R)" })).toHaveAttribute("aria-pressed", "true");
    expect(arrow).toHaveAttribute("aria-pressed", "false");
    expect(arrow.className).not.toContain("bg-primary-50");
    expect(screen.getByTestId("canvas-tool")).toHaveTextContent("rect");
  });

  it("switches tools by key, and cropping shows its own bar until Done", async () => {
    await open();
    fireEvent.keyDown(layer(), { key: "p" });
    expect(screen.getByTestId("canvas-tool")).toHaveTextContent("pixelate");
    fireEvent.keyDown(layer(), { key: "k" });
    expect(screen.getByRole("radiogroup", { name: "Crop shape" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done cropping" }));
    expect(screen.getByTestId("canvas-tool")).toHaveTextContent("select");
    expect(screen.queryByRole("radiogroup", { name: "Crop shape" })).not.toBeInTheDocument();
  });

  it("opens the colour and thickness choices from the colour dot, and Esc closes them first", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Colour and thickness: Red" }));
    const panel = screen.getByRole("dialog", { name: "Colour and thickness" });
    fireEvent.click(within(panel).getByRole("radio", { name: "Blue" }));
    expect(within(panel).getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(panel).getByRole("radio", { name: "Thick" }));
    expect(within(panel).getByRole("radio", { name: "Thick" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Colour and thickness: Blue" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(layer(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Colour and thickness" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the selected annotation's own bar, whose delete removes it", async () => {
    await open();
    expect(screen.queryByRole("toolbar", { name: "Selected annotation" })).not.toBeInTheDocument();
    draw();
    const bar = screen.getByRole("toolbar", { name: "Selected annotation" });
    expect(within(bar).getByRole("radiogroup", { name: "Colour" })).toBeInTheDocument();
    expect(within(bar).getByRole("radiogroup", { name: "Thickness" })).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: "Delete" }));
    expect(screen.queryByRole("toolbar", { name: "Selected annotation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save copy" })).toBeDisabled();
  });

  it("zooms from the fitted size in steps, and the middle of the pill fits again", async () => {
    await open();
    const zoom = screen.getByRole("group", { name: "Zoom" });
    expect(zoom).toHaveTextContent("Fit · 50%");
    fireEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
    expect(screen.getByTestId("canvas-zoom")).toHaveTextContent("0.75");
    fireEvent.click(within(zoom).getByRole("button", { name: /Fit to the window/ }));
    expect(screen.getByTestId("canvas-zoom")).toHaveTextContent("fit");
    fireEvent.keyDown(layer(), { key: "-", metaKey: true });
    expect(screen.getByTestId("canvas-zoom")).toHaveTextContent("0.25");
  });

  it("undoes and redoes with the buttons and the keys", async () => {
    await open();
    const undoButton = screen.getByRole("button", { name: "Undo" });
    expect(undoButton).toBeDisabled();
    draw();
    fireEvent.click(undoButton);
    expect(screen.getByRole("button", { name: "Save copy" })).toBeDisabled();
    fireEvent.keyDown(layer(), { key: "z", metaKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "Save copy" })).toBeEnabled();
  });

  it("copies the flattened picture and says so", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy image" })));
    expect(await screen.findByText("Copied to the clipboard.")).toBeInTheDocument();
    expect(calls("capture_editor_copy")).toHaveLength(1);
  });

  it("says why when there is nothing to open, and Close leaves", async () => {
    tauri.onInvoke("capture_editor_image", () => {
      throw { kind: "Validation", message: "Nothing is open in the editor." };
    });
    render(<EditorApp onClose={onClose} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing is open in the editor.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close" })));
    expect(calls("capture_editor_close")[0][1]).toEqual({ session: 42 });
    expect(onClose).toHaveBeenCalledWith(null);
  });
});

describe("saving", () => {
  it("asks how to save, with Save as a copy first and chosen, and the link warning on Replace", async () => {
    await open();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Save copy" }));
    const dialog = await screen.findByRole("dialog", { name: "Save your edits" });
    const radios = within(dialog).getAllByRole("radio");
    expect(radios.map((r) => r.closest("label")?.textContent)).toEqual([
      expect.stringContaining("Save as a copy"),
      expect.stringContaining("Replace the original"),
    ]);
    expect(radios[0]).toBeChecked();
    expect(radios[0]).toHaveFocus();
    // The file being saved describes the dialog to a screen reader.
    expect(dialog).toHaveAccessibleDescription(CONTEXT.fileName);
    expect(within(dialog).getByText(CONTEXT.copyNote)).toBeInTheDocument();
    expect(within(dialog).getByText(CONTEXT.replaceNote)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Remember my choice" })).not.toBeChecked();
    expect(calls("capture_editor_save")).toHaveLength(0);
  });

  it("saves a copy by default to the open session, then closes with Rust's outcome", async () => {
    await open();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Save copy" }));
    const dialog = await screen.findByRole("dialog", { name: "Save your edits" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save copy" })));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(OUTCOME));
    const [, body, options] = calls("capture_editor_save")[0];
    expect(Array.from(body as Uint8Array)).toEqual([137, 80, 78, 71]);
    expect(options).toEqual({ headers: { "x-editor-session": "42", "x-editor-save-mode": "copy" } });
    expect(calls("capture_editor_close")[0][1]).toEqual({ session: 42 });
    expect(calls("capture_editor_set_save_preference")).toHaveLength(0);
  });

  it("replaces the original and remembers the choice when asked to", async () => {
    await open();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Save copy" }));
    const dialog = await screen.findByRole("dialog", { name: "Save your edits" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Replace the original/ }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Remember my choice" }));
    expect(within(dialog).getByText(/change this in Settings/)).toBeInTheDocument();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Replace" })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls("capture_editor_set_save_preference")[0][1]).toEqual({ preference: "replace" });
    expect(calls("capture_editor_save")[0][2]).toEqual({ headers: { "x-editor-session": "42", "x-editor-save-mode": "replace" } });
  });

  it("starts over on the safe choice each time the dialog opens", async () => {
    await open();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Save copy" }));
    let dialog = await screen.findByRole("dialog", { name: "Save your edits" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Replace the original/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save your edits" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save copy" }));
    dialog = await screen.findByRole("dialog", { name: "Save your edits" });
    expect(within(dialog).getByRole("radio", { name: /Save as a copy/ })).toBeChecked();
  });

  it("does not ask when a choice is remembered, and the button says which", async () => {
    withContext({ savePreference: "copy" });
    await open();
    draw();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save copy" })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Save your edits" })).not.toBeInTheDocument();
    expect(calls("capture_editor_save")[0][2]).toEqual({ headers: { "x-editor-session": "42", "x-editor-save-mode": "copy" } });
  });

  it("offers only Save to Captures for a picture from outside the drives, with no dialog and no mode", async () => {
    withContext({ saveKind: "newCapture", hasPublicLink: false, saveNote: "Your original stays as it is." });
    await open();
    expect(screen.queryByRole("button", { name: "Save copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More ways to save" })).not.toBeInTheDocument();
    draw();
    expect(screen.getByText("Your original stays as it is.")).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save to Captures" })));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Save your edits" })).not.toBeInTheDocument();
    expect(calls("capture_editor_save")[0][2]).toEqual({ headers: { "x-editor-session": "42" } });
  });

  it("offers both ways to save from the chevron, and Replace original opens the dialog on Replace while asking", async () => {
    await open();
    draw();
    fireEvent.keyDown(screen.getByRole("button", { name: "More ways to save" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Save copy", "Replace original"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Replace original" }));
    const dialog = await screen.findByRole("dialog", { name: "Save your edits" });
    expect(within(dialog).getByRole("radio", { name: /Replace the original/ })).toBeChecked();
    expect(calls("capture_editor_save")).toHaveLength(0);
  });

  it("saves straight away the way picked in the menu when a choice is remembered", async () => {
    withContext({ savePreference: "copy" });
    await open();
    draw();
    fireEvent.keyDown(screen.getByRole("button", { name: "More ways to save" }), { key: "Enter" });
    const replace = await screen.findByRole("menuitem", { name: "Replace original" });
    await act(async () => fireEvent.click(replace));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: "Save your edits" })).not.toBeInTheDocument();
    expect(calls("capture_editor_save")[0][2]).toEqual({ headers: { "x-editor-session": "42", "x-editor-save-mode": "replace" } });
  });

  it("names the main button after a remembered Replace", async () => {
    withContext({ savePreference: "replace" });
    await open();
    expect(screen.getByRole("button", { name: "Replace original" })).toBeDisabled();
  });

  it("saves with the keyboard too", async () => {
    withContext({ savePreference: "replace" });
    await open();
    draw();
    await act(async () => fireEvent.keyDown(layer(), { key: "s", metaKey: true }));
    await waitFor(() => expect(calls("capture_editor_save")).toHaveLength(1));
  });

  it("stays open in the dialog and says Rust's sentence when the save is refused", async () => {
    tauri.onInvoke("capture_editor_save", () => {
      throw { kind: "Validation", message: "Storage is full. Upgrade your plan to upload this capture." };
    });
    await open();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Save copy" }));
    const dialog = await screen.findByRole("dialog", { name: "Save your edits" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save copy" })));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Storage is full.");
    expect(calls("capture_editor_close")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Save copy" })).toBeEnabled();
  });
});

describe("leaving", () => {
  it("closes at once with nothing changed", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" })));
    expect(calls("capture_editor_close")[0][1]).toEqual({ session: 42 });
    expect(onClose).toHaveBeenCalledWith(null);
  });

  it("asks before throwing edits away, with Keep editing focused, and Discard closes", async () => {
    await open();
    draw();
    fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    const prompt = await screen.findByRole("alertdialog", { name: "Discard changes?" });
    expect(within(prompt).getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Discard" })));
    expect(onClose).toHaveBeenCalledWith(null);
    expect(calls("capture_editor_save")).toHaveLength(0);
  });

  it("steps back with Esc: the selection first, then the editor, asking about edits", async () => {
    await open();
    draw();
    expect(screen.getByRole("toolbar", { name: "Selected annotation" })).toBeInTheDocument();
    fireEvent.keyDown(layer(), { key: "Escape" });
    expect(screen.queryByRole("toolbar", { name: "Selected annotation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.keyDown(layer(), { key: "Escape" });
    expect(await screen.findByRole("alertdialog", { name: "Discard changes?" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps its keys from the page underneath", async () => {
    await open();
    const pageKeys = vi.fn();
    window.addEventListener("keydown", pageKeys);
    fireEvent.keyDown(layer(), { key: "f", metaKey: true });
    window.removeEventListener("keydown", pageKeys);
    expect(pageKeys).not.toHaveBeenCalled();
  });
});
