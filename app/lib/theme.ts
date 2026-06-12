/**
 * Theme model shared by the boot script, the Jotai theme atoms and the
 * settings UI. Mirrors hippius-console's `src/lib/theme.ts` so both apps
 * use the same storage key, option set and resolution rules.
 *
 * Everything in this file is pure and window-free so it can be unit
 * tested and safely imported during the static-export prerender.
 */

export const THEME_STORAGE_KEY = "hippius-theme";
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

export const THEME_OPTIONS = [
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
  {
    value: "system",
    label: "System",
  },
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number]["value"];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const resolveThemePreference = (
  themePreference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme =>
  themePreference === "system"
    ? systemPrefersDark
      ? "dark"
      : "light"
    : themePreference;

/**
 * Maps whatever is in localStorage (including null for "never set" and
 * junk from older builds) onto a valid preference. Missing or invalid
 * values mean "system" — the same rule the inline boot script applies,
 * so the pre-hydration paint and the React tree can never disagree.
 */
export const parseStoredThemePreference = (
  storedValue: string | null,
): ThemePreference =>
  storedValue === "light" || storedValue === "dark" || storedValue === "system"
    ? storedValue
    : "system";
