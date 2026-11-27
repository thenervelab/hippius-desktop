"use client";

import { forwardRef, useId, useImperativeHandle, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { GateEntry } from "@/app/lib/tauri/shareGate";
import { MUTED } from "./panelStyles";

/** What ends an entry while typing: Rust splits on the same (`parse_entries`). */
const SEPARATOR = /[\s,;]/;

const BOX = cn(
  "flex min-h-[38px] w-full cursor-text flex-wrap items-center gap-1 rounded-[8px] border px-1.5 py-1",
  "border-grey-80 bg-white focus-within:border-primary-50",
  "dark:border-[#494949] dark:bg-[#1f1f1f]",
);

const CHIP = "inline-flex max-w-full items-center gap-0.5 rounded-[6px] py-0.5 pl-2 pr-0.5 text-xs";
const CHIP_OK = "bg-grey-90 text-grey-10 dark:bg-white/10 dark:text-grey-dark-800";
const CHIP_BAD = "bg-error-50/10 text-error-50 ring-1 ring-inset ring-error-50/40 dark:text-error-70 dark:ring-error-70/40";

interface GateChipsProps {
  label: string;
  entries: readonly GateEntry[];
  onChange: (next: GateEntry[]) => void;
  /** Rust's split and check of what was typed. */
  parse: (text: string) => Promise<GateEntry[]>;
  placeholder: string;
  disabled?: boolean;
  /** Beside the label, quieter: what an empty list means. */
  aside?: string;
  /** Whether something is typed and not yet a chip. */
  onTyping?: (typing: boolean) => void;
}

/** What a host can ask of the box: take in what is still typed, and answer the list. */
export interface GateChipsHandle {
  flush: () => Promise<GateEntry[]>;
}

/**
 * A list of emails and domains as chips: typing then Enter, a comma or a
 * space, or pasting a list, makes one chip per entry, and Backspace in the
 * empty box takes the last one back. Rust splits and checks what was typed
 * (`share_parse_gate_entries`), so a chip is exactly what a save stores, and
 * one a save would refuse is drawn as an error chip with Rust's sentence.
 */
export const GateChipsInput = forwardRef<GateChipsHandle, GateChipsProps>(function GateChipsInput(
  { label, entries, onChange, parse, placeholder, disabled = false, aside, onTyping },
  ref,
) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Entries are committed in the order typed, one read of Rust at a time.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(entries);
  latest.current = entries;

  const commit = (text: string) => {
    if (text.trim() === "") return;
    chain.current = chain.current.then(async () => {
      let parsed: GateEntry[];
      try {
        parsed = await parse(text);
      } catch {
        // Rust could not be asked: keep the words as one entry, and the save
        // (which Rust checks again) says what is wrong with it.
        parsed = [{ value: text.trim(), error: null }];
      }
      const have = new Set(latest.current.map((e) => e.value));
      const added = parsed.filter((e) => !have.has(e.value) && (have.add(e.value), true));
      if (added.length > 0) {
        const next = [...latest.current, ...added];
        latest.current = next;
        onChange(next);
      }
    });
  };

  const typed = (value: string) => {
    setDraft(value);
    onTyping?.(value.trim() !== "");
  };

  useImperativeHandle(ref, () => ({
    flush: async () => {
      commit(draft);
      typed("");
      await chain.current;
      return latest.current as GateEntry[];
    },
  }));

  const onText = (value: string) => {
    if (!SEPARATOR.test(value)) {
      typed(value);
      return;
    }
    // Everything up to the last separator becomes chips; the rest stays typed.
    const cut = Math.max(value.lastIndexOf(" "), value.lastIndexOf(","), value.lastIndexOf(";"), value.lastIndexOf("\n"), value.lastIndexOf("\t"));
    commit(value.slice(0, cut));
    typed(value.slice(cut + 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(draft);
      typed("");
    } else if (e.key === "Backspace" && draft === "" && entries.length > 0) {
      e.preventDefault();
      onChange(entries.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!SEPARATOR.test(text)) return;
    e.preventDefault();
    commit(`${draft} ${text}`);
    typed("");
  };

  const bad = entries.find((e) => e.error !== null) ?? null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-xs font-medium text-grey-30 dark:text-grey-dark-700">
          {label}
        </label>
        {aside && entries.length === 0 && <span className={cn("text-xs", MUTED)}>{aside}</span>}
      </div>
      <div className={cn(BOX, disabled && "opacity-60")} onClick={() => inputRef.current?.focus()}>
        {entries.length > 0 && (
          <ul aria-label={`${label}: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`} className="contents">
            {entries.map((entry, i) => (
              <li
                key={entry.value}
                className={cn(CHIP, entry.error ? CHIP_BAD : CHIP_OK)}
                data-testid="gate-chip"
                data-invalid={entry.error ? "true" : undefined}
                title={entry.error ?? entry.value}
              >
                <bdi className="min-w-0 truncate">{entry.value}</bdi>
                {entry.error && <span className="sr-only">, {entry.error}</span>}
                <button
                  type="button"
                  aria-label={`Remove ${entry.value}`}
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(entries.filter((_, j) => j !== i));
                    inputRef.current?.focus();
                  }}
                  className="flex size-4 shrink-0 items-center justify-center rounded-[4px] hover:bg-grey-80 dark:hover:bg-white/15"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={inputRef}
          id={inputId}
          value={draft}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            commit(draft);
            setDraft("");
            // Still "typing" until Rust has made the chips, so a host asking
            // whether anything is unsaved (Back pressed, taking focus here)
            // never hears "no" in between.
            void chain.current.then(() => onTyping?.(draftRef.current.trim() !== ""));
          }}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-invalid={bad ? true : undefined}
          aria-describedby={bad ? errorId : undefined}
          placeholder={entries.length === 0 ? placeholder : ""}
          className={cn(
            "h-7 min-w-[8rem] flex-1 bg-transparent px-1.5 text-xs outline-none",
            "text-grey-10 placeholder:text-grey-60 dark:text-grey-dark-800 dark:placeholder:text-grey-dark-600",
          )}
        />
      </div>
      {bad && (
        <p id={errorId} role="alert" className="break-words text-xs text-error-50 dark:text-error-70">
          {bad.error}
        </p>
      )}
    </div>
  );
});
