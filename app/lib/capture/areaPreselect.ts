import type { LogicalRect } from "@/app/lib/tauri/capture";

/**
 * Rust's preselected area for Wayland's area selection (fractions of the
 * picture, `area_pick::initial_area`) on the picture as the page shows it,
 * in CSS pixels. Rust decides the area; this only scales it onto the
 * picture's box. `null` when there is none or the picture has no box yet.
 */
export function preselectedRect(fraction: LogicalRect | null | undefined, shown: LogicalRect | null): LogicalRect | null {
  if (!fraction || !shown) return null;
  return {
    x: shown.x + fraction.x * shown.width,
    y: shown.y + fraction.y * shown.height,
    width: fraction.width * shown.width,
    height: fraction.height * shown.height,
  };
}
