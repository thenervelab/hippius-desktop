import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import CaptureMenu from "../CaptureMenu";
import { captureRecordingAtom, captureSupportedAtom } from "@/app/lib/capture/captureFlow";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// Reachability given the feature is on; which lane it is on is pinned by
// the flag's own tests.
vi.mock("@/app/lib/featureFlags", () => ({ SCREEN_CAPTURE_ENABLED: true }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(
      cmd === "capture_get_shortcut"
        ? { accelerator: "CommandOrControl+Shift+2", defaultAccelerator: "CommandOrControl+Shift+2" }
        : null,
    ),
  );
});

function renderWith(supported: boolean, recording = false) {
  const store = createStore();
  store.set(captureSupportedAtom, supported);
  store.set(captureRecordingAtom, recording);
  return render(
    <Provider store={store}>
      <CaptureMenu />
    </Provider>,
  );
}

async function openMenu() {
  const trigger = screen.getByRole("button", { name: /capture/i });
  // Radix opens its menu from the keyboard too; jsdom has no real pointer events.
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

describe("CaptureMenu", () => {
  it("offers Capture where the platform can capture", async () => {
    renderWith(true);
    expect(screen.getByRole("button", { name: /capture/i })).toBeInTheDocument();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_get_shortcut"));
  });

  // Linux reports unsupported until its portal path lands: a menu whose every
  // item fails is worse than no menu.
  it("renders nothing where Rust says the platform cannot capture", () => {
    const { container } = renderWith(false);
    expect(container).toBeEmptyDOMElement();
  });

  // The shared DropdownMenuContent's base is `bg-popover`, a token this theme
  // does not define, so a menu that adds no background of its own renders
  // with none: its items invisible in dark mode, which is how this shipped.
  it("draws the open menu on its own background in both themes", async () => {
    renderWith(true);
    const menu = await openMenu();
    const classes = Array.from(menu.classList);
    expect(classes.some((c) => /^bg-(?!popover)/.test(c))).toBe(true);
    expect(classes.some((c) => c.startsWith("dark:bg-"))).toBe(true);
    for (const item of screen.getAllByRole("menuitem")) {
      expect(Array.from(item.classList).some((c) => c.startsWith("dark:text-"))).toBe(true);
    }
  });

  it("names the modes as the capture bar does, and records only where recording works", async () => {
    renderWith(true, false);
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Capture an area" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Capture a window" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Capture entire screen" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Record an area" })).toBeNull();
  });

  it("opens the bar on the chosen mode", async () => {
    renderWith(true, true);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Record a window" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("capture_start", { kind: "recording", mode: "window" }));
  });
});

describe("where Capture is offered", () => {
  // Overview offers it in the Recent Files toolbar beside Folder and File, as
  // a drive's toolbar does (recentFilesCapture.test.tsx renders both). The
  // home header is shared with Billing, Wallet, Referrals and Plans, so it
  // never carries Capture itself.
  it("is in the drive header's two toolbars and in no page header", () => {
    const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
    expect(src("app/components/page-sections/drive/DriveHeader.tsx").match(/<CaptureMenu \/>/g)).toHaveLength(2);
    expect(src("app/components/page-sections/home/PageHeader.tsx")).not.toContain("CaptureMenu");
    for (const page of ["home", "billing", "wallet", "referrals", "drive-plans"]) {
      expect(src(`app/components/page-sections/${page}/index.tsx`)).not.toContain("showCapture");
    }
  });
});
