// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Provider } from "jotai";

import { AppThemeProvider } from "@/app/lib/theme-context";
import { THEME_STORAGE_KEY } from "@/app/lib/theme";
import { ThemeMenuRow } from "../ProfileCard";

function renderRow() {
  return render(
    <Provider>
      <AppThemeProvider>
        <ThemeMenuRow />
      </AppThemeProvider>
    </Provider>,
  );
}

describe("the theme switch in the account menu", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    // jsdom ships no matchMedia, and the theme context resolves "system"
    // through it. Reported as light, so a dark result can only have come
    // from an explicit preference.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });

  // Three states, so three buttons. A two-state toggle cannot express
  // "system", which is the default and the one it would silently destroy.
  it("offers light, dark and system", () => {
    renderRow();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group).toBeInTheDocument();
    for (const label of ["Light", "Dark", "System"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }
  });

  it("marks the stored preference as the selected one", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderRow();
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  // The same preference the Settings page writes, through the same context,
  // so the two surfaces cannot drift apart.
  it("writes the choice where Settings reads it, and applies it", () => {
    renderRow();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  // "system" is stored as absence, so picking it must CLEAR the key rather
  // than write the string, or a later read parses a value it never wrote.
  it("returns to system by clearing the stored value", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderRow();
    fireEvent.click(screen.getByRole("radio", { name: "System" }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
