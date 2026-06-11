"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { Pencil } from "lucide-react";

import ConfirmationDialog from "@/app/components/ConfirmationDialog";
import { renameModalFileAtom } from "@/app/lib/global-atoms/renameAtoms";
import useRenameFile from "@/app/lib/hooks/use-rename-file";
import {
  basenameOf,
  getRenameValidationError,
  isUnchangedName,
  wouldChangeExtension,
} from "./renameValidation";

/**
 * Global rename dialog, mounted once in `app/(pages)/layout.tsx` (same
 * pattern as `ShareFileModal`). Every action surface opens it by setting
 * `renameModalFileAtom`; the actual rename is one Rust IPC
 * (`rename_entry`) that renames on disk and triggers a sync cycle — the
 * engine propagates it to the server as a true rename.
 */
export default function RenameDialog() {
  const [file, setFile] = useAtom(renameModalFileAtom);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { mutate: renameFile, isPending } = useRenameFile();

  const open = file !== null;
  const isFolder = Boolean(file?.isFolder);
  const currentBasename = file ? basenameOf(file.actualFileName || file.name) : "";

  // Prefill with the current basename and select the stem (Finder-style:
  // extension stays selected-out so typing replaces only the name part).
  useEffect(() => {
    if (!file) return;
    const base = basenameOf(file.actualFileName || file.name);
    setNewName(base);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = file.isFolder ? -1 : base.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : base.length);
    });
  }, [file]);

  const validationError = getRenameValidationError(newName);
  const unchanged = isUnchangedName(newName, currentBasename);
  const extensionChanges = !validationError && !unchanged && wouldChangeExtension(newName, currentBasename, isFolder);
  const canConfirm = open && !isPending && !validationError && !unchanged;

  const close = () => {
    if (isPending) return;
    setFile(null);
  };

  // `isPending` only flips on the next render, so keyboard autorepeat on
  // Enter could fire the mutation twice (the second invoke fails post-rename
  // with a confusing "not available on this device" toast). The ref latches
  // synchronously.
  const inFlightRef = useRef(false);

  const confirm = () => {
    if (!file || !canConfirm || inFlightRef.current) return;
    inFlightRef.current = true;
    renameFile(
      { file, newName: newName.trim() },
      {
        onSuccess: () => setFile(null),
        onSettled: () => {
          inFlightRef.current = false;
        },
      },
    );
  };

  return (
    <ConfirmationDialog
      open={open}
      onClose={close}
      onBack={close}
      onConfirm={confirm}
      heading={isFolder ? "Rename Folder" : "Rename File"}
      text={
        <>
          Enter a new name for{" "}
          <span className="break-all font-semibold">{currentBasename}</span>
        </>
      }
      button={isPending ? "Renaming..." : "Rename"}
      icon={<Pencil className="size-[18px] text-white" strokeWidth={2.5} />}
      disableButton={!canConfirm}
      disableBackButton={isPending}
    >
      <div className="mb-6">
        <input
          ref={inputRef}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            }
          }}
          disabled={isPending}
          spellCheck={false}
          autoComplete="off"
          aria-label="New name"
          className="h-11 w-full rounded-lg border border-grey-80 bg-white px-3 text-sm font-medium text-grey-10 outline-none transition-colors focus:border-primary-50 disabled:opacity-60 dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-white"
        />
        {validationError && newName.length > 0 ? (
          <p className="mt-2 text-xs font-medium text-error-50 dark:text-[#fc7d73]">
            {validationError}
          </p>
        ) : extensionChanges ? (
          <p className="mt-2 text-xs font-medium text-grey-50 dark:text-grey-dark-600">
            Changing the extension may make this file open in a different app.
          </p>
        ) : null}
      </div>
    </ConfirmationDialog>
  );
}
