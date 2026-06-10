"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const ZOOM_STEP = 10;
const MIN_ZOOM = 50;
// Capped at 160%: beyond this the effective viewport is so narrow that the
// fixed-width chrome (61px collapsed rail, header) is fundamentally too cramped
// to lay out cleanly. Past the cap is diminishing returns vs. breakage.
const MAX_ZOOM = 160;
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
  // Native webview page zoom = true browser zoom: it scales the ENTIRE UI —
  // rem-based utilities AND the codebase's many hardcoded `px` values —
  // uniformly, and reflows the layout viewport so the `h-screen` app shell
  // keeps filling the window. This replaces the old root-font-size scaling,
  // which only moved rem-based sizes and left every fixed-px element behind —
  // the "some elements scale, some don't" mismatch most visible at low
  // effective resolution. (On macOS this maps to WKWebView `setPageZoom`.)
  try {
    void getCurrentWebviewWindow()
      .setZoom(percent / 100)
      .catch((e) => console.warn("[useZoom] setZoom failed:", e));
  } catch (e) {
    // Non-Tauri context (e.g. `pnpm dev` in a plain browser) has no webview.
    console.warn("[useZoom] setZoom unavailable:", e);
  }
  // Let width-sensitive components (e.g. the sidebar's auto-collapse) recompute.
  window.dispatchEvent(new CustomEvent("zoom-changed", { detail: percent }));
}

/**
 * Manages app zoom via the native webview's page zoom.
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
