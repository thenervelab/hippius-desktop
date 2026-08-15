// Coverage for `FinderExtensionGuard`, the nudge that tells a macOS user their
// Finder extension is switched off.
//
// Why this exists (report 2026-08-15): macOS registers a third-party Finder
// extension but leaves it OFF, so a fresh install has no "Share with Hippius"
// right-click item at all — while every developer Mac looks fine, because
// `macos/dev-finder.sh` enabled it once by bundle id and that election outlives
// reinstalls. The whole feature is therefore invisible to new users until
// something asks them to flip the switch.
//
// The two failure modes this pins are the ones that would make the nudge worse
// than nothing: never showing it (the bug we are fixing), and nagging a user who
// has ALREADY enabled it — which is why the re-check on window focus must
// actually dismiss, and a user who closes the toast must not see it again.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import FinderExtensionGuard from "../FinderExtensionGuard";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({
  toast: toastMock,
}));

type ToastOptions = {
  id?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
};

/** The options object of the single nudge sonner was asked to render. */
function nudgeOptions(): ToastOptions {
  expect(toastMock.warning).toHaveBeenCalledTimes(1);
  return toastMock.warning.mock.calls[0][1] as ToastOptions;
}

/** Resolve the next `finder_extension_state` call with `kind`. */
function stateIs(kind: "enabled" | "disabled" | "unsupported") {
  invokeMock.mockResolvedValue({ kind });
}

/** Fire the window focus the guard re-checks on, and let its promise settle. */
async function refocus() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

describe("FinderExtensionGuard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    toastMock.warning.mockReset();
    toastMock.error.mockReset();
    toastMock.dismiss.mockReset();
  });

  it("nudges when the backend reports the extension is off", async () => {
    stateIs("disabled");
    render(<FinderExtensionGuard />);

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("finder_extension_state");

    const options = nudgeOptions();
    // Persistent: a nudge that auto-closes in 4s is one the user misses.
    expect(options.duration).toBe(Infinity);
    // Stable id — a re-mount (navigation) must reuse the toast, not stack it.
    expect(options.id).toBeTruthy();
    expect(options.action?.label).toBeTruthy();
  });

  it.each(["enabled", "unsupported"] as const)("stays silent when the state is %s", async (kind) => {
    stateIs(kind);
    render(<FinderExtensionGuard />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("finder_extension_state"));
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("opens the system settings pane from the action button", async () => {
    stateIs("disabled");
    render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));

    await act(async () => {
      nudgeOptions().action?.onClick();
    });

    expect(invokeMock).toHaveBeenCalledWith("open_finder_extension_settings");
  });

  it("says so when the settings pane will not open", async () => {
    stateIs("disabled");
    render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));

    // A button that silently does nothing reads as a broken app; the fallback
    // has to name the pane so the user can still get there by hand.
    invokeMock.mockRejectedValueOnce(new Error("no main thread"));
    await act(async () => {
      nudgeOptions().action?.onClick();
    });

    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it("dismisses the nudge once the user has enabled the extension", async () => {
    stateIs("disabled");
    render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    const { id } = nudgeOptions();

    // The user flips the switch in System Settings and comes back to the app.
    stateIs("enabled");
    await refocus();

    expect(toastMock.dismiss).toHaveBeenCalledWith(id);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
  });

  it("does not nudge again after the user closes it", async () => {
    stateIs("disabled");
    render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));

    // Sonner reports the close; the state is still `disabled`, so without this
    // the next focus would re-raise the toast the user just dismissed.
    act(() => nudgeOptions().onDismiss?.());
    await refocus();

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
  });

  it("nudges again if the user opened Settings but did not enable it", async () => {
    stateIs("disabled");
    render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));

    // Sonner closes the toast when its action button is clicked, through the very
    // same `onDismiss`. Treating that as "stop telling me" would cost the
    // reminder to anyone who opens the pane and gets distracted.
    await act(async () => {
      nudgeOptions().action?.onClick();
    });
    act(() => nudgeOptions().onDismiss?.());

    stateIs("disabled");
    await refocus();

    expect(toastMock.warning).toHaveBeenCalledTimes(2);
  });

  it("swallows an IPC failure instead of surfacing it", async () => {
    invokeMock.mockRejectedValue(new Error("command not found"));
    render(<FinderExtensionGuard />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("finder_extension_state"));
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  // A guard that renders nothing and is mounted in exactly one place fails
  // silently when that mount is dropped in a refactor — the same shape as the
  // bug being fixed, so the wiring is pinned rather than assumed. Source-text
  // pin (the repo's `tests/*_wiring.rs` idiom): rendering AppShell here would
  // mean standing up its whole provider tree.
  it("is mounted in AppShell", () => {
    const shell = readFileSync(join(process.cwd(), "app", "components", "AppShell.tsx"), "utf8");
    expect(shell).toContain("<FinderExtensionGuard />");
  });
});
