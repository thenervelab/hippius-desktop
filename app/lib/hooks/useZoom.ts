"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const ZOOM_STEP = 10;
const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const DEFAULT_ZOOM = 100;
const STORAGE_KEY = "hippius-zoom-level";
const INDICATOR_TIMEOUT_MS = 1500;

function loadZoom(): number {
  if (typeof window === "undefined") return DEFAULT_ZOOM;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const val = parseInt(stored, 10);
    if (!isNaN(val) && val >= MIN_ZOOM && val <= MAX_ZOOM) return val;
  }
  return DEFAULT_ZOOM;
}

function applyZoom(percent: number) {
  document.documentElement.style.setProperty(
    "--zoom-factor",
    String(percent / 100)
  );
  // Dispatch a custom event so other components (e.g. sidebar) can react
  window.dispatchEvent(new CustomEvent("zoom-changed", { detail: percent }));
}

/**
 * Manages window zoom via root font-size scaling.
 * Listens for Cmd/Ctrl +/-/0 keyboard shortcuts.
 * Returns current zoom level and whether the indicator should be visible.
 */
export function useZoom() {
  const [zoom, setZoom] = useState(loadZoom);
  const [showIndicator, setShowIndicator] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply zoom on mount and whenever it changes
  useEffect(() => {
    applyZoom(zoom);
    localStorage.setItem(STORAGE_KEY, String(zoom));
  }, [zoom]);

  const flashIndicator = useCallback(() => {
    setShowIndicator(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setShowIndicator(false), INDICATOR_TIMEOUT_MS);
  }, []);

  const zoomIn = useCallback(() => {
    flashIndicator();
    setZoom((prev) => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
  }, [flashIndicator]);

  const zoomOut = useCallback(() => {
    flashIndicator();
    setZoom((prev) => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
  }, [flashIndicator]);

  const resetZoom = useCallback(() => {
    flashIndicator();
    setZoom(DEFAULT_ZOOM);
  }, [flashIndicator]);

  // Keyboard listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = navigator.platform?.includes("Mac") ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      // Zoom in: Cmd/Ctrl + = (or +)
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
      }
      // Zoom out: Cmd/Ctrl + -
      else if (e.key === "-") {
        e.preventDefault();
        zoomOut();
      }
      // Reset: Cmd/Ctrl + 0
      else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomIn, zoomOut, resetZoom]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { zoom, showIndicator };
}
