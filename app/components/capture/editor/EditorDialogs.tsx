"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader } from "lucide-react";
import type { SaveMode } from "@/app/lib/tauri/captureEditor";
import { FOCUS } from "./EditorToolbar";

const BUTTON = `flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-4 text-[13px] font-medium disabled:opacity-50 ${FOCUS}`;
export const SECONDARY = `${BUTTON} border border-black-200 bg-black-400 text-grey-100 hover:bg-black-300`;
export const PRIMARY = `${BUTTON} bg-primary-50 text-grey-100 hover:bg-primary-60`;
const PANEL =
  "fixed left-1/2 top-1/2 z-[1002] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-black-200 bg-black-primary-bg p-5 text-grey-100 shadow-[0_24px_64px_rgba(0,0,0,0.6)] focus:outline-none";
const SCRIM = "fixed inset-0 z-[1001] bg-[#000]/50";

/**
 * "Save…": save a copy (the default, first) or replace the original, and
 * whether to stop asking. The descriptions are Rust's sentences, so the
 * warning about a public link is said only when the file has one.
 */
export function SaveDialog({
  open,
  fileName,
  copyNote,
  replaceNote,
  busy,
  error,
  onCancel,
  onSave,
}: {
  open: boolean;
  fileName: string;
  copyNote: string;
  replaceNote: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (mode: SaveMode, remember: boolean) => void;
}) {
  const [mode, setMode] = useState<SaveMode>("copy");
  const [remember, setRemember] = useState(false);
  const copyRadio = useRef<HTMLInputElement | null>(null);

  // Every opening starts on the safe choice, unremembered.
  useEffect(() => {
    if (open) {
      setMode("copy");
      setRemember(false);
    }
  }, [open]);

  const option = (value: SaveMode, title: string, note: string) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-[12px] border p-3 transition-colors motion-reduce:transition-none ${
        mode === value ? "border-primary-50 bg-primary-50/10" : "border-black-200 hover:bg-black-400"
      }`}
    >
      <input
        ref={value === "copy" ? copyRadio : undefined}
        type="radio"
        name="editor-save-mode"
        value={value}
        checked={mode === value}
        onChange={() => setMode(value)}
        className="mt-0.5 size-4 shrink-0 accent-primary-50"
      />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="mt-0.5 block break-words text-[12.5px] leading-snug text-grey-70">{note}</span>
      </span>
    </label>
  );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={SCRIM} />
        <Dialog.Content
          className={PANEL}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            copyRadio.current?.focus();
          }}
        >
          <Dialog.Title className="text-[16px] font-semibold">Save your edits</Dialog.Title>
          <p className="mt-1 truncate text-[13px] text-grey-70" title={fileName}>
            {fileName}
          </p>
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) onSave(mode, remember);
            }}
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">How to save</legend>
              {option("copy", "Save as a copy", copyNote)}
              {option("replace", "Replace the original", replaceNote)}
            </fieldset>
            <label className="mt-4 flex cursor-pointer items-center gap-2 text-[13px] text-grey-70">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="size-4 accent-primary-50"
              />
              Remember my choice
            </label>
            {remember && (
              <p className="mt-1 pl-6 text-[12px] text-grey-60">You can change this in Settings, under Screenshots &amp; Recording.</p>
            )}
            {error && (
              <p role="alert" className="mt-3 text-[13px] text-[#FF6B60]">
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={onCancel} disabled={busy} className={SECONDARY}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={PRIMARY}>
                {busy && <Loader aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
                {mode === "copy" ? "Save copy" : "Replace"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Leaving with edits: "Keep editing" is the default and has focus, so a
 * stray Return never throws the work away.
 */
export function DiscardDialog({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  const keep = useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onKeep()}>
      <Dialog.Portal>
        <Dialog.Overlay className={SCRIM} />
        <Dialog.Content
          role="alertdialog"
          className={PANEL}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            keep.current?.focus();
          }}
        >
          <Dialog.Title className="text-[16px] font-semibold">Discard changes?</Dialog.Title>
          <Dialog.Description className="mt-1 text-[13px] text-grey-70">Your edits will be lost. The picture stays as it was.</Dialog.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button ref={keep} type="button" onClick={onKeep} className={SECONDARY}>
              Keep editing
            </button>
            <button type="button" onClick={onDiscard} className={`${BUTTON} bg-[#D92D20] text-grey-100 hover:bg-[#B42318]`}>
              Discard
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
