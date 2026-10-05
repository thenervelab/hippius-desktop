/**
 * Arrow-key movement through a row or column of controls (a menu, a radio
 * group, a toolbar), decided without the DOM so it can be tested. Wraps at
 * both ends, as macOS menus and toolbars do.
 */

export type KeyAxis = "vertical" | "horizontal" | "both";

const NEXT: Record<KeyAxis, readonly string[]> = {
  vertical: ["ArrowDown"],
  horizontal: ["ArrowRight"],
  both: ["ArrowDown", "ArrowRight"],
};
const PREV: Record<KeyAxis, readonly string[]> = {
  vertical: ["ArrowUp"],
  horizontal: ["ArrowLeft"],
  both: ["ArrowUp", "ArrowLeft"],
};

/**
 * The index `key` moves to from `at` among `count` items, or null when the
 * key does not move (a letter, Enter, or an empty list). `at` of -1 means
 * nothing is focused yet: the next key starts at the first item, the
 * previous key at the last.
 */
export function stepIndex(key: string, at: number, count: number, axis: KeyAxis): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (NEXT[axis].includes(key)) return at < 0 ? 0 : (at + 1) % count;
  if (PREV[axis].includes(key)) return at < 0 ? count - 1 : (at - 1 + count) % count;
  return null;
}

/**
 * Whether a key press started on a control that answers it itself (a button,
 * a menu, a radio group), so the page-wide Return / arrow handlers must leave
 * it alone: Return on a focused Options button opens the menu, it does not
 * also take the capture.
 */
export function isFromControl(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return (
    target.closest(
      'button, a[href], input, select, textarea, [role="menu"], [role="radiogroup"], [role="switch"], [role="toolbar"], [role="dialog"]',
    ) !== null
  );
}
