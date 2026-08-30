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

/**
 * Synchronous Linux detect from the webview user-agent. webkit2gtk
 * contains "Linux"; WKWebView and WebView2 do not. Android is excluded
 * (this is a desktop app). Shared with the tray so the menu-on-left-click
 * fallback cannot drift from Reveal copy.
 */
export function isLinuxPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /linux/i.test(ua) && !/android/i.test(ua);
}

/** "Finder" / "Explorer" / "file manager" for reveal-in-folder copy. */
export function fileManagerLabel(): string {
  if (isMacPlatform()) return "Finder";
  if (isLinuxPlatform()) return "file manager";
  return "Explorer";
}

export default isMacPlatform;
