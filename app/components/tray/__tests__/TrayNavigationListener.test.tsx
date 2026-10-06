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

import TrayNavigationListener from "../TrayNavigationListener";
import { takeTrayDrop, TRAY_UPLOAD_PATHS_EVENT } from "@/app/lib/tray/trayDrop";

beforeEach(() => {
  tauri.reset();
  nav.push.mockClear();
  nav.toFiles.mockClear();
  takeTrayDrop();
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
