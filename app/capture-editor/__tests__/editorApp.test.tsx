import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

// The canvas needs a real 2D context; here it is a stand-in that makes one
// change when asked, which is all Save, Cancel and Undo need to see.
vi.mock("../EditorCanvas", () => ({
  default: (props: { tool: string; onCommit: (doc: unknown, sel: string | null) => void }) => (
    <div>
      <span data-testid="canvas-tool">{props.tool}</span>
      <button
        type="button"
        onClick={() =>
          props.onCommit({ annotations: [{ id: "s1", kind: "step", at: { x: 1, y: 1 }, n: 1, color: "#FF3B30", size: 20 }], crop: null }, "s1")
        }
      >
        fake draw
      </button>
    </div>
  ),
}));

const exportPng = vi.hoisted(() => vi.fn(async () => new Uint8Array([137, 80, 78, 71])));
vi.mock("@/app/lib/capture/editor/render", async (orig) => ({ ...(await orig<object>()), exportPng }));

import EditorApp from "../EditorApp";

const CONTEXT = {
  session: 42,
  fileName: "Screenshot 2026-10-05 at 10.00.00.png",
  driveName: "Work",
  mime: "image/png",
  saveNote: "Saving replaces the screenshot and its link. The old link stops working.",
};

const calls = (cmd: string) => tauri.core.invoke.mock.calls.filter(([c]) => c === cmd);

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("capture_editor_context", () => CONTEXT);
  tauri.onInvoke("capture_editor_image", () => new ArrayBuffer(8));
  tauri.onInvoke("capture_editor_close", () => null);
  tauri.onInvoke("capture_editor_save", () => ({ message: "Screenshot saved." }));
  tauri.onInvoke("capture_editor_copy", () => null);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 800, height: 500, close() {} })),
  );
  exportPng.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function open() {
  render(<EditorApp />);
  return screen.findByRole("toolbar", { name: "Tools" });
}

describe("screenshot editor", () => {
  it("shows a skeleton until the picture has loaded, then the tools and Rust's note about Save", async () => {
    render(<EditorApp />);
    expect(screen.getByTestId("editor-skeleton")).toBeInTheDocument();
    await screen.findByRole("toolbar", { name: "Tools" });
    expect(screen.queryByTestId("editor-skeleton")).not.toBeInTheDocument();
    expect(screen.getByText(CONTEXT.saveNote)).toBeInTheDocument();
    expect(screen.getByText(CONTEXT.fileName)).toBeInTheDocument();
  });

  it("says why when there is nothing to open", async () => {
    tauri.onInvoke("capture_editor_context", () => null);
    render(<EditorApp />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/no picture to edit/i);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(calls("capture_editor_close")).toHaveLength(1);
  });

  it("switches tools by button and by key, with every tool named for a screen reader", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Arrow (A)" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Rectangle (R)" }));
    expect(screen.getByRole("button", { name: "Rectangle (R)" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("canvas-tool")).toHaveTextContent("rect");
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByTestId("canvas-tool")).toHaveTextContent("pixelate");
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByRole("radiogroup", { name: "Crop shape" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done cropping" }));
    expect(screen.getByTestId("canvas-tool")).toHaveTextContent("select");
    for (const name of ["Blur (B)", "Text (T)", "Numbered step (C)", "Highlighter (M)", "Ellipse (E)", "Line (L)", "Crop (K)", "Select and move (V)"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("saves the flattened picture to the open session, then closes", async () => {
    await open();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "fake draw" }));
    expect(save).toBeEnabled();
    await act(async () => fireEvent.click(save));
    await waitFor(() => expect(calls("capture_editor_close")).toHaveLength(1));
    expect(exportPng).toHaveBeenCalledTimes(1);
    const [, body, options] = calls("capture_editor_save")[0];
    expect(Array.from(body as Uint8Array)).toEqual([137, 80, 78, 71]);
    expect(options).toEqual({ headers: { "x-editor-session": "42" } });
  });

  it("saves with the keyboard too", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "fake draw" }));
    await act(async () => fireEvent.keyDown(window, { key: "s", metaKey: true, ctrlKey: true }));
    await waitFor(() => expect(calls("capture_editor_save")).toHaveLength(1));
  });

  it("stays open and says Rust's sentence when the save is refused", async () => {
    tauri.onInvoke("capture_editor_save", () => {
      throw { kind: "Validation", message: "Storage is full. Upgrade your plan to upload this capture." };
    });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "fake draw" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(await screen.findByText("Storage is full. Upgrade your plan to upload this capture.")).toBeInTheDocument();
    expect(calls("capture_editor_close")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("cancels at once with nothing changed, and asks first when there are edits", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls("capture_editor_close")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "fake draw" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("alertdialog", { name: "Discard your edits?" });
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(dialog).not.toBeInTheDocument();
    expect(calls("capture_editor_close")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(calls("capture_editor_close")).toHaveLength(2);
    expect(calls("capture_editor_save")).toHaveLength(0);
  });

  it("asks before the window's close button throws edits away", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "fake draw" }));
    await act(async () => tauri.emitEvent("capture_editor_close_requested", null));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(calls("capture_editor_close")).toHaveLength(0);
  });

  it("undoes and redoes with the buttons and the keys", async () => {
    await open();
    const undoButton = screen.getByRole("button", { name: "Undo" });
    expect(undoButton).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "fake draw" }));
    expect(screen.getByRole("button", { name: "Delete selected" })).toBeEnabled();
    fireEvent.click(undoButton);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "z", metaKey: true, ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("copies the flattened picture and says so", async () => {
    await open();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Copy/ })));
    expect(await screen.findByText("Copied to the clipboard.")).toBeInTheDocument();
    expect(calls("capture_editor_copy")).toHaveLength(1);
  });

  it("picks a colour and a size from labelled groups", async () => {
    await open();
    const blue = screen.getByRole("radio", { name: "Blue" });
    fireEvent.click(blue);
    expect(blue).toHaveAttribute("aria-checked", "true");
    const thick = screen.getByRole("radio", { name: "Thick" });
    fireEvent.click(thick);
    expect(thick).toHaveAttribute("aria-checked", "true");
  });
});
