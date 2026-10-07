import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
const main = vi.hoisted(() => ({
  isMinimized: vi.fn(() => Promise.resolve(false)),
  unminimize: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  setFocus: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: vi.fn(() => Promise.resolve(main)) },
}));
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock("@/app/lib/utils/isMacPlatform", () => ({
  isMacPlatform: () => platform.mac,
  isLinuxPlatform: () => false,
  fileManagerLabel: () => (platform.mac ? "Finder" : "Explorer"),
  default: () => platform.mac,
}));

import TrayHeaderMenu, { PLAN_UNAVAILABLE } from "../TrayHeaderMenu";
import { TRAY_OPEN_PAGE_EVENT } from "@/app/lib/tray/trayHeaderMenu";

const OVERVIEW = {
  usedBytes: 640e9,
  totalBytes: 2e12,
  percent: 32,
  source: "subscription",
  plan: { name: "Plus", code: "duo", amount: 10, interval: "month", storageBytes: 2e12, storageDisplay: "2 TB", funding: "credits", renewsInDays: 12 },
  creditsHip: "12.34",
  freeTierEntitled: true,
  usedPending: false,
  usedDisplay: "640 GB",
  totalDisplay: "2.20 TB",
  freeDisplay: "1.36 TB",
  overDisplay: null,
  planAction: "none",
  canShareDrives: true,
};

const emitted = (name: string) =>
  tauri.event.emit.mock.calls.filter(([n]: unknown[]) => n === name).map(([, p]: unknown[]) => p);
const invoked = (name: string) => tauri.core.invoke.mock.calls.filter(([n]: unknown[]) => n === name);

beforeEach(() => {
  tauri.reset();
  platform.mac = true;
  main.show.mockClear();
  // Rust refuses the account-scoped command without the session's account.
  tauri.onInvoke("get_storage_overview", (args?: Record<string, unknown>) => {
    if (args?.accountId !== ACCOUNT) throw { kind: "Auth", message: "account_id absent" };
    return OVERVIEW;
  });
  tauri.onInvoke("hide_tray_panel", () => null);
  tauri.onInvoke("app_close", () => null);
  tauri.onInvoke("reveal_drive_in_finder", () => null);
});

const ACCOUNT = "5CnpLffpekNuymDX8";

async function openMenu(showCapturesFolder = true, accountId: string | null = ACCOUNT) {
  render(<TrayHeaderMenu balance="12.3456" accountId={accountId} showCapturesFolder={showCapturesFolder} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
  return screen.findByRole("menu", { name: "More" });
}

const itemTexts = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((el) => el.textContent);

describe("the tray's ⋮ menu", () => {
  it("lists balance, plan, the app's places and Quit, with the Mac's keys", async () => {
    const menu = await openMenu();
    await within(menu).findByTestId("tray-menu-plan");
    expect(itemTexts(menu)).toEqual([
      "Balance$12.35Top up",
      "PlanPlus · 640 GB / 2 TB",
      "Open Hippius⌘O",
      "Open captures folder",
      "Settings⌘,",
      "Help & Support",
      "Quit Hippius⌘Q",
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    expect(within(menu).getByRole("menuitem", { name: /^Quit Hippius/ })).toHaveAttribute("aria-keyshortcuts", "Meta+Q");
  });

  it("asks for the plan as the signed-in account", async () => {
    const menu = await openMenu();
    await within(menu).findByTestId("tray-menu-plan");
    expect(invoked("get_storage_overview")).toEqual([["get_storage_overview", { accountId: ACCOUNT }]]);
  });

  it("waits for the session before asking for the plan", async () => {
    const menu = await openMenu(true, null);
    expect(invoked("get_storage_overview")).toEqual([]);
    expect(within(menu).queryByTestId("tray-menu-plan")).not.toBeInTheDocument();
  });

  it("says the plan could not be loaded instead of loading for ever", async () => {
    tauri.onInvoke("get_storage_overview", () => {
      throw { kind: "Network", message: "offline" };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const menu = await openMenu();
    expect(await within(menu).findByTestId("tray-menu-plan")).toHaveTextContent(PLAN_UNAVAILABLE);
  });

  it("shows Ctrl off the Mac", async () => {
    platform.mac = false;
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: /^Open Hippius/ })).toHaveTextContent("Ctrl+O");
    expect(within(menu).getByRole("menuitem", { name: /^Settings/ })).toHaveTextContent("Ctrl+,");
    expect(within(menu).getByRole("menuitem", { name: /^Quit Hippius/ })).toHaveAttribute("aria-keyshortcuts", "Control+Q");
  });

  it("leaves the captures folder out where capture is not offered", async () => {
    const menu = await openMenu(false);
    expect(within(menu).queryByRole("menuitem", { name: /captures folder/ })).not.toBeInTheDocument();
  });

  it("tops up on the console through the main window, without bringing it forward", async () => {
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Top up/ }));
    await waitFor(() => expect(emitted(TRAY_OPEN_PAGE_EVENT)).toEqual([{ page: "top-up" }]));
    expect(main.show).not.toHaveBeenCalled();
    expect(invoked("hide_tray_panel")).toHaveLength(1);
  });

  it("opens Subscription Plans from the plan, Settings and Help in the main window", async () => {
    let menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Plan:/ }));
    await waitFor(() => expect(emitted(TRAY_OPEN_PAGE_EVENT)).toEqual([{ page: "plans" }]));
    expect(main.show).toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    menu = await screen.findByRole("menu", { name: "More" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Settings/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    menu = await screen.findByRole("menu", { name: "More" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Help & Support/ }));
    await waitFor(() =>
      expect(emitted(TRAY_OPEN_PAGE_EVENT)).toEqual([{ page: "plans" }, { page: "settings" }, { page: "support" }]),
    );
  });

  it("reveals the captures drive's folder when it is on this computer", async () => {
    tauri.onInvoke("capture_drive_status", () => ({
      state: "ready",
      label: "Captures",
      name: "Captures",
      remote: false,
      location: { path: "/Users/me/Documents/Hippius Captures", place: "Documents › Hippius Captures", permissionNote: null },
    }));
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /captures folder/ }));
    await waitFor(() => expect(invoked("reveal_drive_in_finder")).toEqual([["reveal_drive_in_finder", { label: "Captures" }]]));
    expect(emitted(TRAY_OPEN_PAGE_EVENT)).toEqual([]);
  });

  it("opens the Captures page when the captures drive is not on this computer", async () => {
    tauri.onInvoke("capture_drive_status", () => ({ state: "ready", label: "Captures", name: "Captures", remote: true, location: null }));
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /captures folder/ }));
    await waitFor(() => expect(emitted(TRAY_OPEN_PAGE_EVENT)).toEqual([{ page: "captures" }]));
    expect(invoked("reveal_drive_in_finder")).toEqual([]);
  });

  it("quits through the same command as the tray icon's menu", async () => {
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Quit Hippius/ }));
    await waitFor(() => expect(invoked("app_close")).toHaveLength(1));
  });

  it("answers its keys while the popover has the keyboard, menu closed", async () => {
    render(<TrayHeaderMenu balance={null} accountId={ACCOUNT} showCapturesFolder />);
    await act(async () => fireEvent.keyDown(window, { key: ",", metaKey: true }));
    await waitFor(() => expect(emitted(TRAY_OPEN_PAGE_EVENT)).toEqual([{ page: "settings" }]));
    await act(async () => fireEvent.keyDown(window, { key: "o", metaKey: true }));
    await waitFor(() => expect(main.setFocus).toHaveBeenCalled());
    await act(async () => fireEvent.keyDown(window, { key: "q", metaKey: true }));
    await waitFor(() => expect(invoked("app_close")).toHaveLength(1));
    // Not a shortcut of this menu: left alone.
    await act(async () => fireEvent.keyDown(window, { key: "w", metaKey: true }));
    expect(emitted(TRAY_OPEN_PAGE_EVENT)).toHaveLength(1);
  });

  it("closes when the popover loses focus", async () => {
    const menu = await openMenu();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(menu).not.toBeInTheDocument());
  });
});
