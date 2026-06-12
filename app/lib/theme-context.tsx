"use client";

import React, { useEffect } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import {
  ResolvedTheme,
  SYSTEM_THEME_QUERY,
  THEME_STORAGE_KEY,
  ThemePreference,
  parseStoredThemePreference,
  resolveThemePreference,
} from "@/lib/theme";

/**
 * Desktop port of hippius-console's `lib/ThemeContext.tsx`.
 *
 * The preference (light | dark | system) lives in localStorage under the
 * same key the console uses; the *resolved* theme is applied by toggling
 * the `dark` class on <html> (Tailwind runs `darkMode: "selector"`).
 * `AppThemeProvider` is mounted once per webview window — the main app
 * tree AND the provider-free tray-panel branch both mount it in
 * `AppShell`, so every window follows the preference independently from
 * the shared localStorage. The inline boot script in `app/layout.tsx`
 * applies the same rules before first paint to avoid a theme flash.
 */

const getSystemPrefersDark = () =>
  window.matchMedia(SYSTEM_THEME_QUERY).matches;

const applyThemePreference = (
  themePreference: ThemePreference,
): ResolvedTheme => {
  const resolvedTheme = resolveThemePreference(
    themePreference,
    getSystemPrefersDark(),
  );
  const rootElement = document.documentElement;

  rootElement.classList.toggle("dark", resolvedTheme === "dark");
  rootElement.style.colorScheme = resolvedTheme;
  rootElement.dataset.themePreference = themePreference;

  return resolvedTheme;
};

/**
 * Raw (unquoted) localStorage adapter. "system" is the default, so it is
 * stored as *absence* — a fresh install carries no key, and re-selecting
 * System cleans the entry up. `subscribe` relays the `storage` event so a
 * change made in one webview window propagates to any other open window
 * (e.g. main window → tray panel) without a reload.
 */
const themePreferenceStorage = {
  getItem: (key: string, initialValue: ThemePreference): ThemePreference => {
    if (typeof window === "undefined") return initialValue;
    return parseStoredThemePreference(window.localStorage.getItem(key));
  },
  setItem: (key: string, value: ThemePreference): void => {
    if (value === "system") {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  },
  removeItem: (key: string): void => {
    window.localStorage.removeItem(key);
  },
  subscribe: (
    key: string,
    callback: (value: ThemePreference) => void,
  ): (() => void) => {
    if (typeof window === "undefined") return () => {};
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || event.key !== key) {
        return;
      }
      callback(parseStoredThemePreference(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  },
};

const themePreferenceAtom = atomWithStorage<ThemePreference>(
  THEME_STORAGE_KEY,
  "system",
  themePreferenceStorage,
  {
    getOnInit: true,
  },
);
const themeLoadedAtom = atom(false);
const resolvedThemeAtom = atom<ResolvedTheme>("light");

export const AppThemeProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const themePreference = useAtomValue(themePreferenceAtom);
  const setIsLoaded = useSetAtom(themeLoadedAtom);
  const setResolvedTheme = useSetAtom(resolvedThemeAtom);

  useEffect(() => {
    setResolvedTheme(applyThemePreference(themePreference));
    setIsLoaded(true);
  }, [setIsLoaded, setResolvedTheme, themePreference]);

  // While on "system", a live OS theme switch must re-resolve without a
  // preference change. Explicit light/dark ignore the OS entirely.
  useEffect(() => {
    if (themePreference !== "system") return;

    const mediaQueryList = window.matchMedia(SYSTEM_THEME_QUERY);
    const handleSystemThemeChange = () => {
      setResolvedTheme(applyThemePreference(themePreference));
    };

    mediaQueryList.addEventListener("change", handleSystemThemeChange);
    return () =>
      mediaQueryList.removeEventListener("change", handleSystemThemeChange);
  }, [setResolvedTheme, themePreference]);

  return <>{children}</>;
};

export const useAppTheme = () => {
  return {
    isLoaded: useAtomValue(themeLoadedAtom),
    resolvedTheme: useAtomValue(resolvedThemeAtom),
    setThemePreference: useSetAtom(themePreferenceAtom),
    themePreference: useAtomValue(themePreferenceAtom),
  };
};
