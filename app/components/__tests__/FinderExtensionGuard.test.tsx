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

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({
  toast: toastMock,
}));

type ToastOptions = {
  id?: string;
  duration?: number;
  description?: string;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
};

/** The options object of the single nudge sonner was asked to render. */
function nudgeOptions(): ToastOptions {
  expect(toastMock.warning).toHaveBeenCalledTimes(1);
  return toastMock.warning.mock.calls[0][1] as ToastOptions;
}

type Kind = "enabled" | "disabled" | "unsupported";

/**
 * What the backend currently reports, and what its two action commands do.
 *
 * Routed by command name rather than by call order: the action button now runs
 * `enable_finder_extension` FIRST and only falls back to
 * `open_finder_extension_settings`, so a positional mock would silently feed
 * one command's answer to the other.
 */
let state: Kind;
let enableExtension: () => unknown;
let openSettings: () => unknown;

/** Set what `finder_extension_state` reports from here on. */
function stateIs(kind: Kind) {
  state = kind;
}

/** Make the enable command succeed, as a real registration + election would. */
function enableSucceeds() {
  enableExtension = () => {
    state = "enabled";
    return { kind: "enabled" };
  };
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
    toastMock.success.mockReset();
    toastMock.dismiss.mockReset();

    state = "disabled";
    // Default: the enable attempt runs but does not take (the extension stays
    // off), which is the path that must fall back to the settings pane.
    enableExtension = () => ({ kind: state });
    openSettings = () => undefined;

    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case "finder_extension_state":
          return { kind: state };
        case "enable_finder_extension":
          return enableExtension();
        case "open_finder_extension_settings":
          return openSettings();
        default:
          return undefined;
      }
    });
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

  // Sequoia 15.2+ / Tahoe put Finder Sync under File Providers. The Finder
  // category is Apple's Quick Actions, so "enable under Finder" sends the user
  // to a list that can never contain Hippius (report 2026-08-26, Tahoe 26.3).
  it("points at File Providers, not the Finder Quick Actions list", async () => {
    stateIs("disabled");
    render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));

    const description = nudgeOptions().description ?? "";
    expect(description).toMatch(/File Providers/);
    expect(description).not.toMatch(/under Finder in/);
  });

  it.each(["enabled", "unsupported"] as const)("stays silent when the state is %s", async (kind) => {
    stateIs(kind);
    render(<FinderExtensionGuard />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("finder_extension_state"));
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  /** Raise the nudge, then press its action button. */
  async function pressAction() {
    render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    await act(async () => {
      nudgeOptions().action?.onClick();
    });
  }

  // The heart of the fix (report 2026-08-26): an extension macOS never
  // registered appears in NO settings pane, so the old "open the pane" button
  // could not work no matter how the notice was worded. Rust registers and
  // elects it directly; Settings is only the fallback.
  it("enables the extension directly from the action button", async () => {
    enableSucceeds();
    await pressAction();

    expect(invokeMock).toHaveBeenCalledWith("enable_finder_extension");
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    // Sending the user to Settings after it already worked would undo the point.
    expect(invokeMock).not.toHaveBeenCalledWith("open_finder_extension_settings");
  });

  it("falls back to the settings pane when the enable does not take", async () => {
    await pressAction();

    expect(invokeMock).toHaveBeenCalledWith("enable_finder_extension");
    expect(invokeMock).toHaveBeenCalledWith("open_finder_extension_settings");
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  // An older backend has no such command, and a build embedding no extension
  // refuses it. Neither may strand the user on a dead button.
  it("falls back to the settings pane when the enable command fails", async () => {
    enableExtension = () => {
      throw new Error("command not found");
    };
    await pressAction();

    expect(invokeMock).toHaveBeenCalledWith("open_finder_extension_settings");
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  // `unsupported` means the backend could not verify the outcome. Claiming
  // success on an unverified answer is worse than an extra trip to Settings.
  it("does not claim success when the result cannot be verified", async () => {
    enableExtension = () => ({ kind: "unsupported" });
    await pressAction();

    expect(toastMock.success).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("open_finder_extension_settings");
  });

  it("says so when the settings pane will not open", async () => {
    // A button that silently does nothing reads as a broken app; the fallback
    // has to name the pane so the user can still get there by hand.
    openSettings = () => {
      throw new Error("no main thread");
    };
    await pressAction();

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const fallback = toastMock.error.mock.calls[0][1] as { description?: string };
    expect(fallback.description).toMatch(/File Providers/);
    expect(fallback.description).not.toMatch(/under Finder/);
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

    // Model the real library: sonner removes the toast on an action click by
    // calling `deleteToast()` itself, and does NOT invoke `onDismiss` (verified
    // in sonner 2.0.7 — only the close button, a swipe, and a programmatic
    // `toast.dismiss` reach it). Calling `onDismiss` here too would assert a
    // sequence that never happens in production, and did: it hid the notice
    // being suppressed for the rest of the session after its own action button
    // was used.
    await act(async () => {
      nudgeOptions().action?.onClick();
    });

    stateIs("disabled");
    await refocus();

    expect(toastMock.warning).toHaveBeenCalledTimes(2);
  });

  it("clears a notice left behind by a previous mount", async () => {
    stateIs("disabled");
    const first = render(<FinderExtensionGuard />);
    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledTimes(1));
    const { id } = nudgeOptions();
    first.unmount();

    // The remounted instance has fresh refs, so it cannot know it was this
    // component that raised the notice. With `duration: Infinity`, a guard that
    // only dismisses what it personally raised leaves the toast up forever.
    stateIs("enabled");
    render(<FinderExtensionGuard />);

    await waitFor(() => expect(toastMock.dismiss).toHaveBeenCalledWith(id));
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
