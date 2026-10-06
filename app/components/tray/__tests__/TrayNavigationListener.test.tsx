import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const nav = vi.hoisted(() => ({ push: vi.fn(), toFiles: vi.fn() }));
vi.mock("@/app/lib/hooks/useFilesNavigation", () => ({
  useFilesNavigation: () => ({ navigateToFilesView: nav.toFiles }),
}));
vi.mock("@/app/lib/hooks/useNavigationLoader", () => ({
  default: () => ({ push: nav.push }),
}));
const links = vi.hoisted(() => ({ openLinkByKey: vi.fn(() => Promise.resolve()) }));
vi.mock("@/app/lib/utils/links", () => links);

import TrayNavigationListener from "../TrayNavigationListener";
import { takeTrayDrop, TRAY_UPLOAD_PATHS_EVENT } from "@/app/lib/tray/trayDrop";
import { TRAY_OPEN_PAGE_EVENT } from "@/app/lib/tray/trayHeaderMenu";

beforeEach(() => {
  tauri.reset();
  nav.push.mockClear();
  nav.toFiles.mockClear();
  links.openLinkByKey.mockClear();
  takeTrayDrop();
});

describe("the popover's menu, in the main window", () => {
  async function mounted() {
    render(<TrayNavigationListener />);
    await waitFor(() => expect(tauri.event.listen).toHaveBeenCalledWith(TRAY_OPEN_PAGE_EVENT, expect.any(Function)));
  }

  it.each([
    ["plans", "/drive-plans"],
    ["settings", "/settings"],
    ["support", "/support"],
    ["captures", "/captures"],
  ])("opens %s at %s", async (page, route) => {
    await mounted();
    await tauri.emitEvent(TRAY_OPEN_PAGE_EVENT, { page });
    expect(nav.push).toHaveBeenCalledWith(route);
    expect(links.openLinkByKey).not.toHaveBeenCalled();
  });

  it("tops up on the console, as every other Top up does", async () => {
    await mounted();
    await tauri.emitEvent(TRAY_OPEN_PAGE_EVENT, { page: "top-up" });
    expect(links.openLinkByKey).toHaveBeenCalledWith("CREDITS");
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("goes nowhere for a name it does not know, or a route sent as one", async () => {
    await mounted();
    await tauri.emitEvent(TRAY_OPEN_PAGE_EVENT, { page: "/wallet" });
    await tauri.emitEvent(TRAY_OPEN_PAGE_EVENT, { page: "https://example.com" });
    await tauri.emitEvent(TRAY_OPEN_PAGE_EVENT, null);
    expect(nav.push).not.toHaveBeenCalled();
    expect(links.openLinkByKey).not.toHaveBeenCalled();
  });
});

describe("files dropped on the tray popover, in the main window", () => {
  it("send the window to the Drive page and park the files for its upload dialog", async () => {
    render(<TrayNavigationListener />);
    await waitFor(() => expect(tauri.event.listen).toHaveBeenCalledWith(TRAY_UPLOAD_PATHS_EVENT, expect.any(Function)));
    await tauri.emitEvent(TRAY_UPLOAD_PATHS_EVENT, { paths: ["/Users/me/a.png"] });
    expect(nav.toFiles).toHaveBeenCalled();
    expect(nav.push).toHaveBeenCalledWith("/files");
    expect(takeTrayDrop()).toEqual(["/Users/me/a.png"]);
  });

  it("ignore a payload that is not a list of paths", async () => {
    render(<TrayNavigationListener />);
    await waitFor(() => expect(tauri.event.listen).toHaveBeenCalledWith(TRAY_UPLOAD_PATHS_EVENT, expect.any(Function)));
    await tauri.emitEvent(TRAY_UPLOAD_PATHS_EVENT, { paths: "nope" });
    expect(nav.push).not.toHaveBeenCalled();
    expect(takeTrayDrop()).toBeNull();
  });
});
