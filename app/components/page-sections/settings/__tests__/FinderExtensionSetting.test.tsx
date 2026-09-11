// The Settings switch for the Finder extension.
//
// It is the way back for a user who chose "Don't ask again" on the nudge:
// Rust reports that state as `muted`, and the row must render it as OFF with
// a working switch rather than hide, or the choice would be permanent. It
// must also hide on `unsupported` (no extension in this build), so a dev
// binary never shows a switch that cannot work.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import FinderExtensionSetting from "../FinderExtensionSetting";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

type Kind = "enabled" | "disabled" | "muted" | "unsupported";

let state: Kind;
/** What `set_finder_extension_preference` answers, or throws. */
let setPreference: (preference: string) => { kind: Kind };

describe("FinderExtensionSetting", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    toastMock.warning.mockReset();
    toastMock.error.mockReset();
    state = "disabled";
    setPreference = (preference) => {
      state = preference === "wanted" ? "enabled" : "muted";
      return { kind: state };
    };
    invokeMock.mockImplementation(async (command: string, args?: { preference?: string }) => {
      switch (command) {
        case "finder_extension_state":
          return { kind: state };
        case "set_finder_extension_preference":
          return setPreference(args?.preference ?? "");
        default:
          throw new Error(`unexpected command ${command}`);
      }
    });
  });

  it("renders the switch on for an enabled extension", async () => {
    state = "enabled";
    render(<FinderExtensionSetting />);

    const toggle = await screen.findByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it.each(["disabled", "muted"] as const)("renders the switch off, not hidden, when the state is %s", async (kind) => {
    state = kind;
    render(<FinderExtensionSetting />);

    const toggle = await screen.findByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("renders nothing when the build has no extension to switch", async () => {
    state = "unsupported";
    const { container } = render(<FinderExtensionSetting />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("finder_extension_state"));
    expect(container).toBeEmptyDOMElement();
  });

  it("turning it on records the preference in Rust and shows the result", async () => {
    state = "muted";
    render(<FinderExtensionSetting />);
    const toggle = await screen.findByRole("switch");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(invokeMock).toHaveBeenCalledWith("set_finder_extension_preference", { preference: "wanted", switchOff: false });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("turning it off records the preference in Rust", async () => {
    state = "enabled";
    render(<FinderExtensionSetting />);
    const toggle = await screen.findByRole("switch");

    await act(async () => {
      fireEvent.click(toggle);
    });

    // Unlike "Don't ask again", the switch's off means the extension itself.
    expect(invokeMock).toHaveBeenCalledWith("set_finder_extension_preference", { preference: "unwanted", switchOff: true });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  // The election ran but macOS still reads the switch as off (a second
  // registered copy, an MDM profile). The row must not pretend otherwise,
  // and must say where to look.
  it("says so when turning it on did not take", async () => {
    state = "disabled";
    setPreference = () => ({ kind: "disabled" });
    render(<FinderExtensionSetting />);
    const toggle = await screen.findByRole("switch");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const options = toastMock.warning.mock.calls[0][1] as { description?: string };
    expect(options.description).toMatch(/File Providers/);
  });

  it("surfaces a refused change and re-reads the truth", async () => {
    state = "disabled";
    setPreference = () => {
      throw new Error("Move Hippius to your Applications folder first, then try again.");
    };
    render(<FinderExtensionSetting />);
    const toggle = await screen.findByRole("switch");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    // Re-read after the failure, so the row cannot be left showing a guess.
    expect(invokeMock.mock.calls.filter(([command]) => command === "finder_extension_state")).toHaveLength(2);
  });
});
