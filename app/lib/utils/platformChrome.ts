/**
 * Left clearance for window headers that sit under the native title bar.
 *
 * macOS (`titleBarStyle: "Overlay"`): the traffic lights float over the webview
 * at a FIXED PHYSICAL position — they don't scale with the native page zoom the
 * app uses (useZoom). A plain `pl-[80px]` clearance shrinks physically when
 * zooming out, sliding the header content underneath the lights. Multiplying by
 * `--zoom-inverse` (set by useZoom to 100/zoom, 1 when no native zoom applied)
 * keeps the clearance at a constant 80 *physical* px at every zoom level.
 *
 * Other platforms: the window has normal decorations above the webview, so a
 * small static inset is all that's needed — unaffected by this compensation.
 */
export const TITLEBAR_CLEARANCE_MAC = "pl-[calc(80px*var(--zoom-inverse,1))]";
export const TITLEBAR_CLEARANCE_OTHER = "pl-[12px]";

/** The titlebar clearance class for the current platform. */
export function titlebarClearanceClass(isMac: boolean): string {
  return isMac ? TITLEBAR_CLEARANCE_MAC : TITLEBAR_CLEARANCE_OTHER;
}

/**
 * Title-band sizing that never shrinks physically below the traffic lights.
 *
 * `max(<px>, calc(<px> * var(--zoom-inverse)))`: with no compensation
 * (non-mac, or no native zoom) the var is 1 and these resolve to exactly the
 * plain value — zero behavior change. On macOS zoomed OUT (inverse > 1) the
 * band grows in CSS px so its PHYSICAL height stays constant and the content
 * below never rises into the fixed-position traffic lights. Zoomed in
 * (inverse < 1) the plain value wins and the band scales up normally.
 */
export const TITLEBAR_BAND_H_54 =
  "h-[max(54px,calc(54px*var(--zoom-inverse,1)))]";
export const TITLEBAR_BAND_H_44 =
  "h-[max(44px,calc(44px*var(--zoom-inverse,1)))]";
/** Top offset for sidebars pinned below the 54px title band — same formula. */
export const BELOW_TITLEBAR_TOP_54 =
  "top-[max(54px,calc(54px*var(--zoom-inverse,1)))]";
