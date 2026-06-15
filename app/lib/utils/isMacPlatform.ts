/**
 * Best-effort macOS detection from the browser environment.
 *
 * Used purely for presentation — e.g. deciding whether to show the ⌘ glyph
 * (macOS) or a "Ctrl" label (Windows/Linux) for a keyboard-shortcut hint.
 * The shortcut handlers themselves accept both Cmd and Ctrl, so a wrong guess
 * only mislabels the hint; it never breaks behavior.
 *
 * Mirrors the inline checks in the title-bar components (`TopBarLogoMenu`,
 * `AuthTitleBar`, `FileViewerLayout`): match `navigator.platform` first, then
 * fall back to the user-agent string (`navigator.platform` is deprecated and
 * empty in some engines, while the UA reliably carries "Macintosh"). Returns
 * `false` in any non-browser context.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator.platform || "").toLowerCase();
  const ua = (navigator.userAgent || "").toLowerCase();
  return platform.includes("mac") || ua.includes("mac");
}

export default isMacPlatform;
