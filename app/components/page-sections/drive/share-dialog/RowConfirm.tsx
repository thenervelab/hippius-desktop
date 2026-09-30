"use client";

// Asking before a change that takes access away, inside the row itself.
//
// The Share dialog and the Manage access panel are already a dialog (the
// panel is one on a narrow window), so a confirmation dialog opened a second
// one on top. Instead the row swaps its subline for a short question and its
// right side for the destructive button and Cancel. Escape or Cancel puts
// the row back and focus returns to the control that asked; the confirm
// button takes focus while the question shows. One row asks at a time: the
// provider holds which one, and asking in another row puts the first back.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

type ActiveRow = {
  active: string | null;
  setActive: Dispatch<SetStateAction<string | null>>;
};

const RowConfirmContext = createContext<ActiveRow | null>(null);

/** Around a list whose rows ask: only one of them asks at a time. */
export function RowConfirmProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  const value = useMemo(() => ({ active, setActive }), [active]);
  return <RowConfirmContext.Provider value={value}>{children}</RowConfirmContext.Provider>;
}

/**
 * Put on the control that opens a row's question (or a wrapper around it):
 * focus returns there when the question is put away.
 */
export const ROW_TRIGGER = { "data-row-trigger": "" } as const;

const FOCUSABLE = "button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * One row's question. `asking` is which question it shows (a row may have
 * more than one, like Remove and a demotion), or null. `rowRef` goes on the
 * row's normal root, which takes focus after a confirmed change, while the
 * row says "Removing…".
 */
export function useRowConfirm<K extends string>(key: string) {
  const shared = useContext(RowConfirmContext);
  const [localActive, setLocalActive] = useState<string | null>(null);
  const active = shared ? shared.active : localActive;
  const setActive = shared ? shared.setActive : setLocalActive;
  const [kind, setKind] = useState<K | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const restore = useRef(false);
  const asking = active === key ? kind : null;

  const ask = useCallback(
    (next: K) => {
      setKind(next);
      setActive(key);
    },
    [key, setActive],
  );
  const putAway = useCallback(() => {
    restore.current = true;
    setKind(null);
    setActive((current) => (current === key ? null : current));
  }, [key, setActive]);

  useEffect(() => {
    if (asking !== null || !restore.current) return;
    restore.current = false;
    const root = rowRef.current;
    if (!root) return;
    const marked = root.querySelector<HTMLElement>("[data-row-trigger]");
    const target = marked?.matches(FOCUSABLE) ? marked : marked?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? root).focus({ preventScroll: true });
  }, [asking]);

  return { asking, ask, cancel: putAway, done: putAway, rowRef };
}

/**
 * Escape runs `onEscape` before the dialog around `ref` sees the key, so the
 * first Escape puts back a question or a view and never closes the whole
 * dialog. Only while focus is inside `ref` (or nowhere): a select or menu
 * open elsewhere keeps its own Escape. Caught on the window in the capture
 * phase, because Radix listens on the document, also capturing.
 */
export function useEscapeFirst(ref: React.RefObject<HTMLElement | null>, onEscape: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const focused = document.activeElement;
      const inside = !focused || focused === document.body || ref.current?.contains(focused);
      if (!inside) return;
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ref, onEscape]);
}

/**
 * The question a row shows in place of its subline, and the destructive
 * button and Cancel in place of its right side. It wraps on a narrow column:
 * the buttons move, together, under the words.
 */
export function RowConfirm({
  leading,
  title,
  question,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
  destructive = true,
  className,
}: {
  /** The avatar or icon the row keeps. */
  leading?: React.ReactNode;
  /** The row's name line, kept so the row stays recognisable. */
  title?: React.ReactNode;
  question: string;
  /** One more short line, when the change does more than the question says. */
  detail?: string | null;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** A role change is not a removal: its button is the primary one. */
  destructive?: boolean;
  className?: string;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);

  // Focus the confirm button. A menu or select that opened the question
  // hands focus back to its own trigger a moment after it closes, so ask
  // again then, unless focus already moved somewhere in the question.
  useEffect(() => {
    confirmRef.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => {
      if (!groupRef.current?.contains(document.activeElement)) confirmRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEscapeFirst(groupRef, onCancel);

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={question}
      className={cn("flex min-h-[48px] min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 py-2", className)}
    >
      {leading}
      <div className="min-w-0 flex-1 basis-[150px] overflow-hidden">
        {title}
        <p className="break-words text-xs text-grey-10 [overflow-wrap:anywhere] dark:text-white">{question}</p>
        {detail ? (
          <p className="mt-0.5 break-words text-xs text-grey-50 [overflow-wrap:anywhere] dark:text-grey-dark-600">
            {detail}
          </p>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button
          ref={confirmRef}
          type="button"
          variant={destructive ? "destructive" : "primary"}
          size="auto"
          onClick={onConfirm}
          className={cn("h-8 shrink-0 rounded-[6px] px-3 text-xs font-medium", destructive && "text-white")}
        >
          {confirmLabel}
        </Button>
        <Button
          type="button"
          variant="defaultStable"
          size="auto"
          onClick={onCancel}
          className="h-8 shrink-0 rounded-[6px] px-3 text-xs font-medium"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
