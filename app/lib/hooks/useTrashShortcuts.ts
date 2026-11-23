import { useEffect, useRef } from "react";
import { isMacPlatform } from "@/app/lib/capture/shortcutLabel";

/** Typing in a field is never a delete. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Which delete a key press asks for, if any. On a Mac, Finder's keys:
 * Cmd+Backspace moves to Trash and Cmd+Option+Backspace deletes forever.
 * Elsewhere, Delete and Shift+Delete, plus Ctrl+Backspace as on a Mac.
 */
export function shortcutAction(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean,
): "trash" | "forever" | null {
  const command = mac ? e.metaKey : e.ctrlKey;
  if (e.key === "Backspace" && command) return e.altKey ? "forever" : "trash";
  if (!mac && e.key === "Delete" && !e.ctrlKey && !e.altKey && !e.metaKey) return e.shiftKey ? "forever" : "trash";
  return null;
}

/** Delete shortcuts for the selection, while `enabled`. */
export function useTrashShortcuts({
  enabled,
  onTrash,
  onForever,
}: {
  enabled: boolean;
  onTrash: () => void;
  onForever: () => void;
}): void {
  const handlers = useRef({ onTrash, onForever });
  handlers.current = { onTrash, onForever };
  useEffect(() => {
    if (!enabled) return;
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isTypingTarget(e.target)) return;
      const action = shortcutAction(e, mac);
      if (!action) return;
      e.preventDefault();
      if (action === "trash") handlers.current.onTrash();
      else handlers.current.onForever();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** The shortcut for a mode, as the tooltip shows it. */
export function trashShortcutHint(mode: "trash" | "forever" | "legacy", mac: boolean = isMacPlatform()): string {
  if (mode === "forever") return mac ? "⌘⌥⌫" : "Shift+Delete";
  return mac ? "⌘⌫" : "Delete";
}
