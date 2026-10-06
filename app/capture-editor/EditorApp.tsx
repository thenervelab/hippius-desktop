"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy, Loader } from "lucide-react";
import {
  EDITOR_CLOSE_REQUESTED_EVENT,
  closeEditor,
  copyEditedImage,
  getEditorContext,
  getEditorImage,
  saveEditedImage,
  type EditorContext,
} from "@/app/lib/tauri/captureEditor";
import {
  type Doc,
  type History,
  type ToolId,
  commit,
  findAnnotation,
  isDirty,
  moveAnnotation,
  redo,
  removeAnnotation,
  restyle,
  startHistory,
  undo,
  updateAnnotation,
} from "@/app/lib/capture/editor/model";
import { finishText, type Style } from "@/app/lib/capture/editor/gesture";
import { exportPng } from "@/app/lib/capture/editor/render";
import { PALETTE, SIZES, type SizeId, commandFor } from "@/app/lib/capture/editor/shortcuts";
import { ASPECT_PRESETS, fitCropToRatio, redactionBlock, resolveRatio, strokeUnit } from "@/app/lib/capture/editor/view";
import { isMacPlatform } from "@/app/lib/utils/isMacPlatform";
import EditorCanvas, { type TextEdit } from "./EditorCanvas";
import EditorToolbar, { FOCUS } from "./EditorToolbar";
import EditorSkeleton from "./EditorSkeleton";

interface Loaded {
  image: CanvasImageSource;
  w: number;
  h: number;
}

type Status = { text: string; tone: "info" | "error" } | null;

/** Rust's sentence from a rejected `invoke` (`{ kind, message }`), or a plain one. */
function messageOf(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return typeof error === "string" && error ? error : fallback;
}

async function decode(bytes: ArrayBuffer, mime: string): Promise<Loaded> {
  const blob = new Blob([bytes], { type: mime });
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { image: bitmap, w: bitmap.width, h: bitmap.height };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { image: img, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const BUTTON = `flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] font-medium disabled:opacity-50 ${FOCUS}`;
const SECONDARY = `${BUTTON} border border-grey-80 bg-white text-grey-10 hover:bg-grey-90 dark:border-black-300 dark:bg-black-primary-bg dark:text-grey-100 dark:hover:bg-black-300`;
const PRIMARY = `${BUTTON} bg-primary-50 text-white hover:bg-primary-60`;

/**
 * The screenshot editor: a toolbar, the picture, and Cancel / Copy / Save.
 * Rust handed it the picture and takes the flattened PNG back; what happens
 * to the file and its link is Rust's, and the line beside Save says it in
 * Rust's words before the user commits.
 */
export default function EditorApp() {
  const [context, setContext] = useState<EditorContext | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(() => startHistory());
  const [preview, setPreview] = useState<Doc | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<ToolId>("arrow");
  const [color, setColor] = useState(PALETTE[0].color);
  const [sizeId, setSizeId] = useState<SizeId>("m");
  const [aspect, setAspect] = useState("free");
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const [busy, setBusy] = useState<"save" | "copy" | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const keepEditing = useRef<HTMLButtonElement | null>(null);
  const isMac = useMemo(() => isMacPlatform(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await getEditorContext();
        if (!ctx) throw new Error("There is no picture to edit. Open it again from its card or from Drive.");
        const bytes = await getEditorImage();
        const image = await decode(bytes, ctx.mime);
        if (cancelled) return;
        setContext(ctx);
        setLoaded(image);
      } catch (e) {
        if (!cancelled) setLoadError(messageOf(e, "The picture couldn't be opened."));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const doc = preview ?? history.present;
  const dirty = isDirty(history);
  const size = SIZES.find((s) => s.id === sizeId) ?? SIZES[1];
  const unit = loaded ? strokeUnit(loaded.w, loaded.h) : 1;
  const style: Style = { color, stroke: size.stroke * unit, textSize: size.text * unit };
  const block = loaded ? redactionBlock(loaded.w, loaded.h) : 8;
  const preset = ASPECT_PRESETS.find((a) => a.id === aspect) ?? ASPECT_PRESETS[0];
  const ratio = loaded ? resolveRatio(preset, loaded.w, loaded.h) : null;

  const commitDoc = useCallback((next: Doc, sel: string | null) => {
    setHistory((h) => commit(h, next));
    setSelected(sel);
    setStatus(null);
  }, []);

  // Read through a ref: Return ends the typing and the field's blur follows,
  // and the second call must find nothing left to commit.
  const typing = useRef<TextEdit | null>(null);
  typing.current = textEdit;
  const finishTyping = useCallback(
    (cancelled: boolean) => {
      const edit = typing.current;
      typing.current = null;
      setTextEdit(null);
      if (!edit || cancelled) return;
      const next = finishText(history.present, { id: edit.id, at: edit.at }, edit.text, {
        color: edit.color,
        stroke: style.stroke,
        textSize: edit.size,
      });
      if (next) commitDoc(next, null);
    },
    [history.present, style.stroke, commitDoc],
  );

  const chooseTool = (t: ToolId) => {
    if (textEdit) finishTyping(false);
    setTool(t);
    if (t === "crop") setSelected(null);
  };

  const applyStyle = (change: { color?: string; width?: number; textSize?: number }) => {
    if (!selected) return;
    const next = updateAnnotation(history.present, selected, (a) => restyle(a, change));
    if (next !== history.present) commitDoc(next, selected);
  };

  const onColor = (c: string) => {
    setColor(c);
    applyStyle({ color: c });
  };
  const onSize = (id: SizeId) => {
    setSizeId(id);
    const s = SIZES.find((x) => x.id === id) ?? SIZES[1];
    const current = findAnnotation(history.present, selected);
    applyStyle({ width: s.stroke * unit * (current?.kind === "highlight" ? 4 : 1), textSize: s.text * unit });
  };
  const onAspect = (id: string) => {
    setAspect(id);
    const crop = history.present.crop;
    const p = ASPECT_PRESETS.find((a) => a.id === id);
    if (crop && loaded && p) commitDoc({ ...history.present, crop: fitCropToRatio(crop, resolveRatio(p, loaded.w, loaded.h), loaded.w, loaded.h) }, null);
  };
  const deleteSelected = () => {
    if (selected) commitDoc(removeAnnotation(history.present, selected), null);
  };
  const doUndo = () => {
    setHistory(undo);
    setSelected(null);
  };
  const doRedo = () => {
    setHistory(redo);
    setSelected(null);
  };

  const flatten = useCallback(async () => {
    if (!loaded) throw new Error("The picture isn't ready yet.");
    return exportPng(loaded.image, loaded.w, loaded.h, history.present, block);
  }, [loaded, history.present, block]);

  const save = async () => {
    if (!context || busy || !dirty) return;
    setBusy("save");
    setStatus({ text: "Saving…", tone: "info" });
    try {
      const png = await flatten();
      await saveEditedImage(context.session, png);
      // Rust has the outcome on the card, or in a notification when there
      // is more to say than "saved"; the editor's job is done.
      await closeEditor();
    } catch (e) {
      setStatus({ text: messageOf(e, "The screenshot couldn't be saved."), tone: "error" });
      setBusy(null);
    }
  };

  const copy = async () => {
    if (busy || !loaded) return;
    setBusy("copy");
    try {
      await copyEditedImage(await flatten());
      setStatus({ text: "Copied to the clipboard.", tone: "info" });
    } catch (e) {
      setStatus({ text: messageOf(e, "The picture couldn't be copied."), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const cancel = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else void closeEditor();
  }, [dirty]);

  // The window's close button: Rust holds the window and asks the page.
  // Listened to once, through a ref, so the answer always sees the edits.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    const unlisten = listen(EDITOR_CLOSE_REQUESTED_EVENT, () => cancelRef.current());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (confirmClose) keepEditing.current?.focus();
  }, [confirmClose]);

  // Keys: tools, undo / redo, save, copy, delete, nudge. Never while typing.
  const onKey = (e: KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest("textarea, input")) return;
    if (confirmClose) {
      if (e.key === "Escape") {
        e.preventDefault();
        setConfirmClose(false);
      }
      return;
    }
    const cmd = commandFor(e, isMac);
    if (!cmd) return;
    // A focused button keeps Return and Space; Escape and the rest are the editor's.
    if (cmd.type === "applyCrop" && target?.closest("button")) return;
    e.preventDefault();
    switch (cmd.type) {
      case "tool":
        chooseTool(cmd.tool);
        break;
      case "undo":
        doUndo();
        break;
      case "redo":
        doRedo();
        break;
      case "save":
        void save();
        break;
      case "copy":
        void copy();
        break;
      case "delete":
        deleteSelected();
        break;
      case "escape":
        if (selected) setSelected(null);
        else if (tool === "crop") setTool("select");
        else cancel();
        break;
      case "applyCrop":
        if (tool === "crop") setTool("select");
        break;
      case "nudge":
        if (selected) commitDoc(updateAnnotation(history.present, selected, (a) => moveAnnotation(a, cmd.dx * unit, cmd.dy * unit)), selected);
        break;
    }
  };
  const keyHandler = useRef(onKey);
  keyHandler.current = onKey;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (loadError) {
    return (
      <main className="grid h-screen place-items-center bg-grey-90 p-6 text-center text-grey-10 dark:bg-black-600 dark:text-grey-100">
        <div className="max-w-sm">
          <p role="alert" className="text-[14px]">
            {loadError}
          </p>
          <button type="button" onClick={() => void closeEditor()} className={`${SECONDARY} mx-auto mt-4`}>
            Close
          </button>
        </div>
      </main>
    );
  }
  if (!context || !loaded) return <EditorSkeleton />;

  return (
    <main className="flex h-screen flex-col bg-grey-90 text-grey-10 dark:bg-black-600 dark:text-grey-100">
      <h1 className="sr-only">Edit {context.fileName}</h1>
      <EditorToolbar
        tool={tool}
        onTool={chooseTool}
        color={color}
        onColor={onColor}
        size={sizeId}
        onSize={onSize}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        onUndo={doUndo}
        onRedo={doRedo}
        canDelete={selected !== null}
        onDelete={deleteSelected}
        aspect={aspect}
        onAspect={onAspect}
        hasCrop={history.present.crop !== null}
        onResetCrop={() => commitDoc({ ...history.present, crop: null }, null)}
        onApplyCrop={() => setTool("select")}
        modKey={isMac ? "⌘" : "Ctrl+"}
      />
      <div className="min-h-0 flex-1">
        <EditorCanvas
          image={loaded.image}
          imageW={loaded.w}
          imageH={loaded.h}
          doc={doc}
          selected={selected}
          tool={tool}
          style={style}
          ratio={ratio}
          block={block}
          textEdit={textEdit}
          onPreview={setPreview}
          onCommit={commitDoc}
          onSelect={setSelected}
          onStartText={(edit) => {
            const existing = findAnnotation(history.present, edit.id);
            setTextEdit({
              id: edit.id,
              at: edit.at,
              text: existing?.kind === "text" ? existing.text : "",
              color: existing?.kind === "text" ? existing.color : color,
              size: existing?.kind === "text" ? existing.size : style.textSize,
            });
          }}
          onTextChange={(text) => setTextEdit((t) => (t ? { ...t, text } : t))}
          onTextDone={finishTyping}
        />
      </div>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-grey-80 bg-white px-3 py-2 dark:border-black-300 dark:bg-black-primary-bg">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" title={context.fileName}>
            {context.fileName}
          </p>
          <p
            role="status"
            aria-live="polite"
            className={`truncate text-[12px] ${status?.tone === "error" ? "text-[#D92D20] dark:text-[#FF6B60]" : "text-grey-50 dark:text-grey-70"}`}
            title={status?.text ?? context.saveNote}
          >
            {status?.text ?? context.saveNote}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={cancel} disabled={busy === "save"} className={SECONDARY}>
            Cancel
          </button>
          <button type="button" onClick={() => void copy()} disabled={busy !== null} className={SECONDARY} title={`Copy (${isMac ? "⌘" : "Ctrl+"}C)`}>
            <Copy aria-hidden className="size-4" /> Copy
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy !== null || !dirty}
            className={PRIMARY}
            title={dirty ? `Save (${isMac ? "⌘" : "Ctrl+"}S)` : "Nothing to save yet"}
          >
            {busy === "save" ? (
              <Loader aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Check aria-hidden className="size-4" />
            )}
            Save
          </button>
        </div>
      </footer>

      {confirmClose && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-[#000]/40 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-title"
            aria-describedby="discard-body"
            className="w-full max-w-[340px] rounded-[12px] border border-grey-80 bg-white p-4 shadow-xl dark:border-black-300 dark:bg-black-primary-bg"
          >
            <h2 id="discard-title" className="text-[15px] font-semibold">
              Discard your edits?
            </h2>
            <p id="discard-body" className="mt-1 text-[13px] text-grey-50 dark:text-grey-70">
              The screenshot stays as it was.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button ref={keepEditing} type="button" onClick={() => setConfirmClose(false)} className={SECONDARY}>
                Keep editing
              </button>
              <button type="button" onClick={() => void closeEditor()} className={`${BUTTON} bg-[#D92D20] text-white hover:bg-[#B42318]`}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
