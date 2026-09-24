// The Share dev tools panel: nothing at all where the build does not allow
// it; a pill that opens on click or Ctrl+Shift+D; presets and controls that
// store the settings and tell open surfaces; and events that start inside it
// never reaching the document listeners an open Radix modal uses to steal
// focus back or close itself.

import React from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const gate = vi.hoisted(() => ({ staging: true }));
vi.mock("@/app/lib/buildChannel", () => ({
  enabledFrom: (minimum: string) => minimum === "staging" && gate.staging,
}));

import ShareDevTools, { isShareDevToolsShortcut } from "../ShareDevTools";
import { SHARE_DEVTOOLS_EVENT, SHARE_DEVTOOLS_KEY, SHARE_FIXTURE_KEY } from "../shareDevToolsSettings";

const stored = () => JSON.parse(window.localStorage.getItem(SHARE_DEVTOOLS_KEY) ?? "null");

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function openWithShortcut() {
  act(() => {
    fireEvent.keyDown(document.body, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });
  });
}

describe("ShareDevTools", () => {
  it("opens from the pill and from Ctrl+Shift+D, and Escape folds it", () => {
    render(<ShareDevTools />);
    fireEvent.click(screen.getByRole("button", { name: /share dev tools/i }));
    expect(screen.getByRole("region", { name: "Share dev tools" })).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(screen.getByLabelText("Enable fake data"), { key: "Escape", code: "Escape" });
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    openWithShortcut();
    expect(screen.getByRole("region", { name: "Share dev tools" })).toBeInTheDocument();
    openWithShortcut();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("stores a preset and tells open surfaces", () => {
    const heard = vi.fn();
    window.addEventListener(SHARE_DEVTOOLS_EVENT, heard);
    try {
      window.localStorage.setItem(SHARE_FIXTURE_KEY, "12");
      render(<ShareDevTools />);
      openWithShortcut();
      fireEvent.click(screen.getByRole("button", { name: /big drive/i }));
      expect(stored()).toMatchObject({ enabled: true, people: 60, activeLinks: 45, endedLinks: 15 });
      // The older key is folded into the new one.
      expect(window.localStorage.getItem(SHARE_FIXTURE_KEY)).toBeNull();
      expect(heard).toHaveBeenCalled();
    } finally {
      window.removeEventListener(SHARE_DEVTOOLS_EVENT, heard);
    }
  });

  it("writes a slider after the hand stops, and Reset forgets everything", () => {
    vi.useFakeTimers();
    render(<ShareDevTools />);
    openWithShortcut();
    fireEvent.click(screen.getByLabelText("Enable fake data"));
    fireEvent.change(screen.getByRole("slider", { name: "People" }), { target: { value: "80" } });
    expect(stored().people).not.toBe(80);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(stored().people).toBe(80);

    fireEvent.click(screen.getByRole("radio", { name: "3 s" }));
    fireEvent.click(screen.getByRole("radio", { name: "100%" }));
    expect(stored()).toMatchObject({ latencyMs: 3000, failureRate: 100 });

    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(window.localStorage.getItem(SHARE_DEVTOOLS_KEY)).toBeNull();
    expect(screen.getByLabelText("Enable fake data")).not.toBeChecked();
  });

  it("keeps its events from the document listeners a modal uses", () => {
    render(
      <>
        <button type="button">outside</button>
        <ShareDevTools />
      </>,
    );
    openWithShortcut();
    const heard = vi.fn();
    const types = ["pointerdown", "mousedown", "focusin", "keydown", "wheel"];
    types.forEach((t) => document.addEventListener(t, heard));
    try {
      const inside = screen.getByLabelText("Enable fake data");
      fireEvent.pointerDown(inside);
      fireEvent.mouseDown(inside);
      fireEvent.focusIn(inside);
      fireEvent.keyDown(inside, { key: "a" });
      fireEvent.wheel(inside);
      expect(heard).not.toHaveBeenCalled();

      // Focus leaving a modal for the panel is not "focus outside" either.
      const outside = screen.getByRole("button", { name: "outside" });
      const out = vi.fn();
      document.addEventListener("focusout", out);
      fireEvent.focusOut(outside, { relatedTarget: inside });
      expect(out).not.toHaveBeenCalled();
      document.removeEventListener("focusout", out);

      fireEvent.pointerDown(outside);
      expect(heard).toHaveBeenCalled();
    } finally {
      types.forEach((t) => document.removeEventListener(t, heard));
    }
  });

  it("recognises the shortcut on Ctrl or Cmd, and nothing else", () => {
    const base = { ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, code: "KeyD" };
    expect(isShareDevToolsShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isShareDevToolsShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isShareDevToolsShortcut(base)).toBe(false);
    expect(isShareDevToolsShortcut({ ...base, ctrlKey: true, shiftKey: false })).toBe(false);
    expect(isShareDevToolsShortcut({ ...base, ctrlKey: true, code: "KeyS" })).toBe(false);
  });
});

describe("ShareDevTools on a beta or production build", () => {
  it("renders nothing and does not answer the shortcut", async () => {
    gate.staging = false;
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    try {
      const { default: Gated } = await import("../ShareDevTools");
      const { container } = render(<Gated />);
      openWithShortcut();
      expect(container).toBeEmptyDOMElement();
      expect(document.querySelector("[data-share-devtools]")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      gate.staging = true;
      vi.resetModules();
    }
  });
});
