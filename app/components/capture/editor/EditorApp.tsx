"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Loader, X } from "lucide-react";
import {
  closeEditor,
  copyEditedImage,
  getEditorContext,
  getEditorImage,
  saveEditedImage,
  setSavePreference,
  type EditorContext,
  type SaveMode,
  type SaveOutcome,
} from "@/app/lib/tauri/captureEditor";
import {
  type Doc,
  type History,
  type Point,
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
import { ASPECT_PRESETS, ZOOM_LEVELS, fitCropToRatio, nextZoom, redactionBlock, resolveRatio, strokeUnit } from "@/app/lib/capture/editor/view";
import { isMacPlatform } from "@/app/lib/utils/isMacPlatform";
import EditorCanvas, { type TextEdit } from "./EditorCanvas";
import EditorToolbar, { CropBar, ICON_BUTTON } from "./EditorToolbar";
import { SelectionBar, ZoomPill } from "./EditorChrome";
import { DiscardDialog, PRIMARY, SECONDARY, SaveDialog } from "./EditorDialogs";
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

/** The editor layer sits over every page and every other dialog of the app. */
const LAYER = "fixed inset-0 z-[1000] flex flex-col bg-black-600 text-grey-100 outline-none";

interface Props {
  /**
   * The editor is done: closed (`null`) or saved (Rust's outcome). Rust's
   * session is already closed when this is called.
   */
  onClose: (outcome: SaveOutcome | null) => void;
}

/**
 * The screenshot editor, a full-screen layer over the main window's page:
 * Close and the file's name, one floating toolbar, Copy image and Save; the
 * picture fills the rest. Rust handed it the picture and takes the
 * flattened PNG back; what happens to the file and its link is Rust's, and
 * the save dialog says it in Rust's words before the user commits.
 *
 * It is a modal dialog: focus stays inside, Esc steps back (a panel, the
 * selection, the crop, then the editor itself), and focus returns where it
 * was when it closes.
 */
export default function EditorApp({ onClose }: Props) {
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
  const [styleOpen, setStyleOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [center, setCenter] = useState<Point | null>(null);
  const [shownZoom, setShownZoom] = useState(1);
  const isMac = useMemo(() => isMacPlatform(), []);
  const modKey = isMac ? "⌘" : "Ctrl+";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await getEditorContext();
        if (!ctx) throw new Error("There is no picture to edit. Open it again from its card or from Drive.");
        if (!cancelled) setContext(ctx);
        const bytes = await getEditorImage();
        const image = await decode(bytes, ctx.mime);
        if (!cancelled) setLoaded(image);
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

  const zoomStep = useCallback(
    (direction: 1 | -1) => {
      setZoom(nextZoom(shownZoom, direction));
    },
    [shownZoom],
  );
  const zoomFit = () => {
    setZoom(null);
    setCenter(null);
  };

  const flatten = useCallback(async () => {
    if (!loaded) throw new Error("The picture isn't ready yet.");
    return exportPng(loaded.image, loaded.w, loaded.h, history.present, block);
  }, [loaded, history.present, block]);

  const finish = async (outcome: SaveOutcome | null) => {
    if (context) await closeEditor(context.session).catch(() => undefined);
    onClose(outcome);
  };

  const runSave = async (mode: SaveMode | undefined, remember: boolean) => {
    if (!context || busy || !dirty) return;
    setBusy("save");
    setSaveError(null);
    setStatus(saveOpen ? null : { text: "Saving…", tone: "info" });
    try {
      // The choice is stored first: a save that then fails still keeps it.
      if (remember && mode) await setSavePreference(mode).catch(() => undefined);
      const png = await flatten();
      const outcome = await saveEditedImage(context.session, png, mode);
      await finish(outcome);
    } catch (e) {
      const text = messageOf(e, "The picture couldn't be saved.");
      if (saveOpen) setSaveError(text);
      else setStatus({ text, tone: "error" });
      setBusy(null);
    }
  };

  /** Save…: straight to Captures for a picked picture, by the saved choice, or ask. */
  const save = () => {
    if (!context || busy || !dirty) return;
    if (textEdit) finishTyping(false);
    if (context.saveKind === "newCapture") return void runSave(undefined, false);
    if (context.savePreference !== "ask") return void runSave(context.savePreference, false);
    setSaveError(null);
    setSaveOpen(true);
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

  const requestClose = () => {
    if (busy === "save") return;
    if (dirty) setConfirmClose(true);
    else void finish(null);
  };

  // Keys: tools, undo / redo, save, copy, delete, nudge, zoom, Esc. Never
  // while typing, and never while a dialog over the editor has the keys.
  const onKey = (e: React.KeyboardEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (saveOpen || confirmClose) return;
    if (target?.closest("textarea, input")) return;
    const cmd = commandFor(e, isMac);
    // Every key stays in the editor: the page underneath has shortcuts too.
    e.stopPropagation();
    if (!cmd) return;
    // A focused button keeps Return and Space.
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
        save();
        break;
      case "copy":
        void copy();
        break;
      case "delete":
        deleteSelected();
        break;
      case "escape":
        if (styleOpen) setStyleOpen(false);
        else if (selected) setSelected(null);
        else if (tool === "crop") setTool("select");
        else requestClose();
        break;
      case "applyCrop":
        if (tool === "crop") setTool("select");
        break;
      case "zoomIn":
        zoomStep(1);
        break;
      case "zoomOut":
        zoomStep(-1);
        break;
      case "zoomFit":
        zoomFit();
        break;
      case "nudge":
        if (selected) commitDoc(updateAnnotation(history.present, selected, (a) => moveAnnotation(a, cmd.dx * unit, cmd.dy * unit)), selected);
        break;
    }
  };

  const selectedAnnotation = tool === "crop" ? null : findAnnotation(history.present, selected);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && requestClose()}>
      <Dialog.Portal>
        {!loadError && (!context || !loaded) ? (
          <EditorSkeleton />
        ) : (
          <Dialog.Content
            className={LAYER}
            aria-describedby={undefined}
            // Esc is the editor's own: it steps back through what is open first.
            onEscapeKeyDown={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
            onKeyDown={onKey}
          >
            {loadError || !context || !loaded ? (
              <div className="grid flex-1 place-items-center p-6 text-center">
                <div className="max-w-sm">
                  <Dialog.Title className="text-[15px] font-semibold">The picture couldn&apos;t be opened</Dialog.Title>
                  <p role="alert" className="mt-1 text-[14px] text-grey-70">
                    {loadError}
                  </p>
                  <button type="button" onClick={() => void finish(null)} className={`${SECONDARY} mx-auto mt-4`}>
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                <Dialog.Title className="sr-only">Edit {context.fileName}</Dialog.Title>
                <header className="relative flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
                  <div className="flex min-w-0 flex-1 items-center gap-2 lg:max-w-[calc(50%-18rem)]">
                    <button type="button" onClick={requestClose} disabled={busy === "save"} className={ICON_BUTTON} aria-label="Close (Esc)" title="Close (Esc)">
                      <X aria-hidden className="size-[18px]" />
                    </button>
                    <p className="min-w-0 truncate text-[13px] font-medium text-grey-100" title={context.fileName}>
                      {context.fileName}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 lg:order-last">
                    <button
                      type="button"
                      onClick={() => void copy()}
                      disabled={busy !== null}
                      className={SECONDARY}
                      aria-label="Copy image"
                      title={`Copy image (${modKey}C)`}
                    >
                      <Copy aria-hidden className="size-4" />
                      <span className="hidden sm:inline">Copy image</span>
                    </button>
                    <button
                      type="button"
                      onClick={save}
                      disabled={busy !== null || !dirty}
                      className={PRIMARY}
                      title={dirty ? `${saveLabel(context)} (${modKey}S)` : "Nothing to save yet"}
                    >
                      {busy === "save" && !saveOpen && <Loader aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
                      {saveLabel(context)}
                    </button>
                  </div>
                  {/* Top centre on a wide window; its own row on a narrow one. */}
                  <div className="flex w-full flex-col items-center gap-2 lg:absolute lg:left-1/2 lg:top-3 lg:w-auto lg:-translate-x-1/2">
                    <EditorToolbar
                      tool={tool}
                      onTool={chooseTool}
                      color={color}
                      size={sizeId}
                      styleOpen={styleOpen}
                      onStyleOpen={setStyleOpen}
                      onColor={onColor}
                      onSize={onSize}
                      canUndo={history.past.length > 0}
                      canRedo={history.future.length > 0}
                      onUndo={doUndo}
                      onRedo={doRedo}
                      modKey={modKey}
                    />
                    {tool === "crop" && (
                      <CropBar
                        aspect={aspect}
                        onAspect={onAspect}
                        hasCrop={history.present.crop !== null}
                        onReset={() => commitDoc({ ...history.present, crop: null }, null)}
                        onDone={() => setTool("select")}
                      />
                    )}
                  </div>
                </header>

                <div className={`relative min-h-0 flex-1 ${tool === "crop" ? "lg:mt-12" : ""}`}>
                  <div className="absolute inset-x-0 bottom-16 top-0">
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
                      zoom={zoom}
                      center={center}
                      onScale={setShownZoom}
                      onPan={setCenter}
                      onZoomStep={zoomStep}
                      selectionBar={
                        selectedAnnotation && !preview ? (
                          <SelectionBar
                            annotation={selectedAnnotation}
                            color={color}
                            size={sizeId}
                            onColor={onColor}
                            onSize={onSize}
                            onDelete={deleteSelected}
                          />
                        ) : null
                      }
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
                  <div className="absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-4">
                    {status && (
                      <p
                        role={status.tone === "error" ? "alert" : "status"}
                        className={`max-w-full truncate rounded-full bg-black-primary-bg/95 px-3 py-1 text-[12px] ${
                          status.tone === "error" ? "text-[#FF6B60]" : "text-grey-70"
                        }`}
                        title={status.text}
                      >
                        {status.text}
                      </p>
                    )}
                    {!status && context.saveKind === "newCapture" && dirty && (
                      <p className="max-w-full truncate text-[12px] text-grey-70" title={context.saveNote}>
                        {context.saveNote}
                      </p>
                    )}
                    <ZoomPill
                      zoom={shownZoom}
                      fitted={zoom === null}
                      canZoomIn={shownZoom < ZOOM_LEVELS[ZOOM_LEVELS.length - 1] - 1e-6}
                      canZoomOut={shownZoom > ZOOM_LEVELS[0] + 1e-6}
                      onZoomIn={() => zoomStep(1)}
                      onZoomOut={() => zoomStep(-1)}
                      onFit={zoomFit}
                      modKey={modKey}
                    />
                  </div>
                </div>

                <SaveDialog
                  open={saveOpen}
                  fileName={context.fileName}
                  copyNote={context.copyNote}
                  replaceNote={context.replaceNote}
                  busy={busy === "save"}
                  error={saveError}
                  onCancel={() => setSaveOpen(false)}
                  onSave={(mode, remember) => void runSave(mode, remember)}
                />
                <DiscardDialog open={confirmClose} onKeep={() => setConfirmClose(false)} onDiscard={() => void finish(null)} />
              </>
            )}
          </Dialog.Content>
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The Save button says what it will do. */
export function saveLabel(context: EditorContext): string {
  if (context.saveKind === "newCapture") return "Save to Captures";
  if (context.savePreference === "copy") return "Save copy";
  if (context.savePreference === "replace") return "Save";
  return "Save…";
}

