import { ReactNode } from "react";

/**
 * The play/eye icon that fades in at the right edge of a file row on hover,
 * shared by the Video / Image / PDF dialog triggers. Pointer events are
 * disabled so the row's own click target stays whole, and it relies on a
 * `group` ancestor for the `group-hover` reveal.
 *
 * `hidden` removes the icon from the DOM entirely (not just visually) — set it
 * for rows that already show a persistent right-edge status pill (e.g.
 * "Failed"), which the icon would otherwise fade in directly on top of.
 */
export function HoverPreviewIcon({
  children,
  hidden = false,
}: {
  children: ReactNode;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div
      data-testid="hover-preview-icon"
      className="absolute pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100 right-4 inset-y-0 flex items-center"
    >
      {children}
    </div>
  );
}

export default HoverPreviewIcon;
