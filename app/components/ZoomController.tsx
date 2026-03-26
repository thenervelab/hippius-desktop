"use client";

import { useZoom } from "@/lib/hooks/useZoom";

/**
 * Mounts the zoom keyboard shortcut handler and renders a centered
 * zoom-percentage indicator that briefly appears on zoom changes.
 */
export default function ZoomController() {
  const { zoom, showIndicator } = useZoom();

  if (!showIndicator) return null;

  return (
    <div
      className="fixed inset-0 pointer-events-none flex items-center justify-center"
      style={{ zIndex: 9999 }}
    >
      <div className="bg-black/70 text-white text-lg font-semibold px-5 py-2.5 rounded-xl shadow-lg animate-fade-in-0.2">
        {zoom}%
      </div>
    </div>
  );
}
