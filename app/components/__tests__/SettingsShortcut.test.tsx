// ⌘, (Ctrl+, off a Mac) opens Settings from the main window, not only from
// the tray popover's menu.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

import SettingsShortcut from "../SettingsShortcut";

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/hooks/useNavigationLoader", () => ({
  default: () => ({ push: pushMock }),
}));

const macMock = vi.hoisted(() => ({ value: true }));
vi.mock("@/app/lib/utils/isMacPlatform", () => ({
  isMacPlatform: () => macMock.value,
}));

describe("SettingsShortcut", () => {
  beforeEach(() => {
    pushMock.mockReset();
    macMock.value = true;
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens Settings on ⌘, on a Mac", () => {
    render(<SettingsShortcut />);
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(pushMock).toHaveBeenCalledWith("/settings");
  });

  it("opens Settings on Ctrl+, on Windows and Linux", () => {
    macMock.value = false;
    render(<SettingsShortcut />);
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(pushMock).toHaveBeenCalledWith("/settings");
  });

  it("ignores Ctrl+, on a Mac, an extra modifier, and other keys", () => {
    render(<SettingsShortcut />);
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    fireEvent.keyDown(window, { key: ",", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: ",", metaKey: true, altKey: true });
    fireEvent.keyDown(window, { key: ".", metaKey: true });
    fireEvent.keyDown(window, { key: "," });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("leaves a press another handler already took alone", () => {
    render(<SettingsShortcut />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.addEventListener("keydown", (e) => e.preventDefault());
    fireEvent.keyDown(input, { key: ",", metaKey: true });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const { unmount } = render(<SettingsShortcut />);
    unmount();
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(pushMock).not.toHaveBeenCalled();
  });
});
