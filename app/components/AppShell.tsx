"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { AppThemeProvider } from "@/app/lib/theme-context";

/**
 * The full app tree lives in its own chunk. A static import here put it in
 * the root layout's chunk graph, so every window (the tray popover and each
 * capture window, one overlay per display) parsed about 1.4 MB of script it
 * never ran. Rendered on the server as well (the default), so the main
 * window's prerendered HTML and hydration are unchanged.
 */
const FullAppShell = dynamic(() => import("./FullAppShell"));

/**
 * Route prefix served inside the borderless system-tray popover window.
 * The tray panel is a separate Tauri webview that only ever loads this route,
 * while the main app window never navigates to it — so the pathname is a
 * reliable, hydration-safe discriminator between the two windows.
 */
const TRAY_PANEL_ROUTE = "/tray-panel";

/**
 * E2E harness routes (`app/e2e/*`). Like the tray panel, they must NOT boot the
 * full app (auth/session restore/splash would gate or delay the harness page),
 * so they render with only the theme provider. Harmless in production: the
 * routes are unlinked and render a disabled placeholder unless the app was
 * built with `NEXT_PUBLIC_E2E=1`.
 */
const E2E_ROUTE = "/e2e";

/**
 * The screen-capture selection overlay (`app/capture-overlay`), one window
 * per display opened by Rust. Like the tray panel it must not boot the app:
 * it only draws a selection and reports it over `invoke`, and a second auth
 * stack per display would be both slow and wrong.
 */
const CAPTURE_OVERLAY_ROUTE = "/capture-overlay";

/**
 * The floating recording control bar (`app/capture-controls`). Same provider
 * rules as the overlay: no auth stack, theme only.
 */
const CAPTURE_CONTROLS_ROUTE = "/capture-controls";

/**
 * The capture preview card (`app/capture-preview`), in a screen corner after
 * a capture. Same provider rules as the overlay: no auth stack, theme only.
 */
const CAPTURE_PREVIEW_ROUTE = "/capture-preview";

/**
 * The camera bubble / camera-only stage (`app/capture-camera`), filmed with
 * the screen while recording. Same provider rules as the overlay.
 */
const CAPTURE_CAMERA_ROUTE = "/capture-camera";

/**
 * Top-level shell that decides which provider tree to mount based on the
 * window we are running in.
 *
 * The tray popover must NOT boot the full app (auth/session restore, the
 * system-tray initializer, the updater, block subscriptions) — doing so would
 * create a second tray icon and duplicate background work in a throwaway
 * popover. It is a self-contained UI that talks to the backend over `invoke`,
 * so for that window we render just the children with no app providers.
 *
 * Branching on `usePathname()` (rather than a post-mount window-label check)
 * keeps the decision identical between static-export prerender and client
 * hydration, avoiding both a hydration mismatch and a one-frame mount of the
 * full provider tree inside the popover window.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (
    pathname?.startsWith(TRAY_PANEL_ROUTE) ||
    pathname?.startsWith(E2E_ROUTE) ||
    pathname?.startsWith(CAPTURE_OVERLAY_ROUTE) ||
    pathname?.startsWith(CAPTURE_CONTROLS_ROUTE) ||
    pathname?.startsWith(CAPTURE_PREVIEW_ROUTE) ||
    pathname?.startsWith(CAPTURE_CAMERA_ROUTE)
  ) {
    // The popover skips the app providers but still mounts the theme
    // provider so it follows the System/Light/Dark preference (shared
    // via localStorage) and tracks live OS theme changes. It uses the
    // default Jotai store — fine, since each window applies the theme
    // independently from the same stored preference.
    return <AppThemeProvider>{children}</AppThemeProvider>;
  }

  return <FullAppShell>{children}</FullAppShell>;
}
