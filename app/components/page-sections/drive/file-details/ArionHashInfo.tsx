"use client";

import React, { useEffect, useId, useRef, useState } from "react";

const SPLIT_TEXT =
  "Files over 8 MB are split into 8 MB parts. Each part is encrypted, broken into shards and spread across many storage nodes, so no single node holds your file.";
const PARTS_TEXT =
  "Each part has its own Arion Hash you can look up on the File Tracker.";
const SINGLE_TEXT =
  "Your file is encrypted, broken into shards and spread across many storage nodes. Its Arion Hash lets you look it up on the File Tracker.";

/**
 * The "i" beside the Arion Hash label: how the file is stored. Opens on
 * click or Enter/Space, closes on Escape, a second click or a click outside.
 */
const ArionHashInfo: React.FC<{ inParts: boolean }> = ({ inParts }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    // Capture phase on the window, so this Escape closes only the
    // explanation and not the side panel around it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [open]);

  return (
    // Not `relative`: the explanation is placed against the Arion Hash
    // block, so it spans the panel's width instead of running off its edge.
    <span ref={wrapRef} className="inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label="How your file is stored"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex size-[14px] items-center justify-center rounded-full border border-black-900/40 text-[9px] font-semibold leading-none text-black-900/50 hover:border-[#3167dd] hover:text-[#3167dd] focus-visible:border-[#3167dd] focus-visible:text-[#3167dd] focus-visible:outline-none dark:border-white/40 dark:text-white/50 dark:hover:border-[#618ce8] dark:hover:text-[#618ce8]"
      >
        i
      </button>
      {open ? (
        <span
          id={panelId}
          role="dialog"
          aria-label="How your file is stored"
          className="absolute left-2 right-2 top-[34px] z-20 flex flex-col gap-2 rounded-[10px] border border-grey-80 bg-white px-3 py-[10px] text-[12px] font-medium normal-case leading-4 tracking-[-0.24px] text-grey-40 shadow-lg dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-600"
        >
          {inParts ? (
            <>
              <span>{SPLIT_TEXT}</span>
              <span>{PARTS_TEXT}</span>
            </>
          ) : (
            <span>{SINGLE_TEXT}</span>
          )}
        </span>
      ) : null}
    </span>
  );
};

export default ArionHashInfo;
