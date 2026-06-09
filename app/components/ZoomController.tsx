"use client";

import { useZoom } from "@/lib/hooks/useZoom";

/**
 * Mounts the zoom keyboard shortcut handler and renders a centered
 * zoom-percentage indicator that briefly appears on zoom changes.
 */
export default function ZoomController() {
  const { zoom, showIndicator } = useZoom();

  if (!showIndicator) return null;

  const limitLabel = zoom <= 50 ? " (min)" : zoom >= 200 ? " (max)" : "";

  return (
    <div
      className="fixed inset-0 pointer-events-none flex items-center justify-center"
      style={{ zIndex: 9999 }}
    >
      {/* Explicit rgba (not bg-black/70): the black palette has no DEFAULT key,
          so bg-black/<alpha> compiles to nothing — leaving white text on the
          page with no pill, invisible in light mode. */}
      <div className="bg-[rgba(0,0,0,0.7)] text-white text-lg font-semibold px-5 py-2.5 rounded-xl shadow-lg animate-fade-in-0.2">
        {zoom}%{limitLabel}
      </div>
    </div>
  );
}
