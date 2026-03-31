"use client";

import { useState, useEffect } from "react";

/** Baseline root font-size (px) that chart margins/font sizes were designed at. */
const BASELINE_PX = 16;

/**
 * Returns a multiplier representing the current root font-size relative to
 * the 16px design baseline. When the fluid `clamp()` or `--zoom-factor`
 * changes the root font-size, this value updates so SVG-pixel values
 * (margins, font sizes) can scale proportionally.
 *
 * Example: at 13px root → returns 0.8125; at 16px → 1; at 20px → 1.25.
 */
export function useRemScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const update = () => {
      const rootFontSize = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      setScale(rootFontSize / BASELINE_PX);
    };

    update();

    // Re-measure when the window resizes (viewport-based clamp changes).
    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);

    // Also re-measure when the zoom level changes via Cmd/Ctrl +/-/0.
    // ResizeObserver alone won't fire when only the CSS --zoom-factor
    // variable changes (the html element dimensions stay the same).
    // The useZoom hook dispatches a "zoom-changed" custom event that
    // we listen for here. We use a rAF to read the computed font-size
    // after the browser has applied the new CSS variable value.
    const onZoomChanged = () => requestAnimationFrame(update);
    window.addEventListener("zoom-changed", onZoomChanged);

    return () => {
      ro.disconnect();
      window.removeEventListener("zoom-changed", onZoomChanged);
    };
  }, []);

  return scale;
}
