// Whether a row is being dragged inside the app right now.
//
// The page's Finder-drop listener (`tauri://drag-*` in DriveContent)
// reads this and stands down: an in-app move must never show the upload
// overlay or start an upload, whatever the webview reports while the
// pointer is down.

let active = false;

export function setInAppDragActive(value: boolean): void {
  active = value;
}

export function isInAppDragActive(): boolean {
  return active;
}

/**
 * Swallow the click a finished drag leaves behind. The pointer went down
 * and up on rows, so the browser fires a click on whatever both share, and
 * a drag dropped back where it started would open the file it began on.
 */
export function suppressNextClick(): void {
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  // Not every drag ends in a click; never let the trap catch a later one.
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}
