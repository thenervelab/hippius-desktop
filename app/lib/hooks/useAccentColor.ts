"use client";

import { useCallback, useEffect, useState } from "react";

/** Curated accent color presets */
export const ACCENT_PRESETS = [
  { name: "blue", label: "Blue", hex: "#3167DD" },
  { name: "purple", label: "Purple", hex: "#6D46DC" },
  { name: "teal", label: "Teal", hex: "#14AA9E" },
  { name: "green", label: "Green", hex: "#1EAC4B" },
  { name: "orange", label: "Orange", hex: "#EB6E0F" },
  { name: "red", label: "Red", hex: "#E13728" },
  { name: "pink", label: "Pink", hex: "#DC3291" },
  { name: "indigo", label: "Indigo", hex: "#414BDC" },
] as const;

export type AccentPreset = (typeof ACCENT_PRESETS)[number]["name"];

const STORAGE_KEY = "hippius-accent-color";
const CUSTOM_STORAGE_KEY = "hippius-accent-custom-hex";

/**
 * Converts a hex color to HSL components.
 */
function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

/**
 * Converts HSL to RGB string (space-separated for CSS vars).
 */
function hslToRGB(h: number, s: number, l: number): string {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lNorm - c / 2;

  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return `${Math.round((r + m) * 255)} ${Math.round((g + m) * 255)} ${Math.round((b + m) * 255)}`;
}

/**
 * Generates a 10-shade scale from a hex color.
 * Shades go from lightest (100) to darkest (10).
 */
function generateAccentScale(
  hex: string,
  isDark: boolean,
): Record<string, string> {
  const { h, s } = hexToHSL(hex);
  const lightLevels = [95, 88, 78, 65, 52, 42, 34, 26, 18, 5];
  const darkLevels = [8, 14, 22, 32, 45, 55, 65, 75, 86, 94];
  const levels = isDark ? darkLevels : lightLevels;
  const keys = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
  const scale: Record<string, string> = {};

  keys.forEach((key, i) => {
    scale[`--primary-${key}`] = hslToRGB(h, s, levels[i]);
  });

  return scale;
}

/**
 * Hook for managing the accent color preference.
 * Reads/writes to localStorage and applies the `data-accent` attribute on `<html>`.
 */
export function useAccentColor() {
  const [accent, setAccentState] = useState<string>("blue");
  const [customHex, setCustomHexState] = useState<string>("#3167DD");

  // Initialize from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const storedCustom = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (stored) setAccentState(stored);
    if (storedCustom) setCustomHexState(storedCustom);
  }, []);

  // Apply accent to DOM whenever it changes
  useEffect(() => {
    const html = document.documentElement;

    if (accent === "custom") {
      // Remove data-accent so preset overrides don't apply
      html.removeAttribute("data-accent");
      const isDark = html.classList.contains("dark");
      const scale = generateAccentScale(customHex, isDark);
      Object.entries(scale).forEach(([prop, value]) => {
        html.style.setProperty(prop, value);
      });
    } else if (accent === "blue") {
      // Blue is the default — remove any overrides
      html.removeAttribute("data-accent");
      clearInlineVars(html);
    } else {
      clearInlineVars(html);
      html.setAttribute("data-accent", accent);
    }
  }, [accent, customHex]);

  // Re-generate custom scale when dark mode toggles
  useEffect(() => {
    if (accent !== "custom") return;

    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.classList.contains("dark");
      const scale = generateAccentScale(customHex, isDark);
      Object.entries(scale).forEach(([prop, value]) => {
        document.documentElement.style.setProperty(prop, value);
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, [accent, customHex]);

  const setAccent = useCallback((name: string) => {
    setAccentState(name);
    localStorage.setItem(STORAGE_KEY, name);
  }, []);

  const setCustomHex = useCallback(
    (hex: string) => {
      setCustomHexState(hex);
      localStorage.setItem(CUSTOM_STORAGE_KEY, hex);
      if (accent === "custom") {
        // Trigger re-render to apply new custom color
        setAccentState("custom");
      }
    },
    [accent],
  );

  const resetToDefaults = useCallback(() => {
    setAccent("blue");
    clearInlineVars(document.documentElement);
  }, [setAccent]);

  return { accent, setAccent, customHex, setCustomHex, resetToDefaults };
}

/** Remove inline CSS variable overrides for primary colors */
function clearInlineVars(el: HTMLElement) {
  [100, 90, 80, 70, 60, 50, 40, 30, 20, 10].forEach((n) => {
    el.style.removeProperty(`--primary-${n}`);
  });
}

/**
 * Applies the saved accent color on mount.
 * Mount this once at the app root so the accent is restored on startup
 * without waiting for the settings page to render.
 */
export function applyStoredAccent() {
  if (typeof window === "undefined") return;

  const accent = localStorage.getItem(STORAGE_KEY);
  const customHex = localStorage.getItem(CUSTOM_STORAGE_KEY);
  const html = document.documentElement;

  if (!accent || accent === "blue") {
    // Default — no overrides needed
    return;
  }

  if (accent === "custom" && customHex) {
    const isDark = html.classList.contains("dark");
    const scale = generateAccentScale(customHex, isDark);
    Object.entries(scale).forEach(([prop, value]) => {
      html.style.setProperty(prop, value);
    });
  } else {
    html.setAttribute("data-accent", accent);
  }
}
