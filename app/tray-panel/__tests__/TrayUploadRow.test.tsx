import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
  configure,
  cleanup,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";

configure({ asyncUtilTimeout: 5000 });

const invoke = vi.fn();
const emit = vi.fn(() => Promise.resolve());
const main = {
  isMinimized: vi.fn(() => Promise.resolve(false)),
  unminimize: vi.fn(() => Promise.resolve()),
  show: vi.fn(() => Promise.resolve()),
  setFocus: vi.fn(() => Promise.resolve()),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => emit(...(args as [])),
}));
vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: vi.fn(() => Promise.resolve(main)) },
}));

// Edit (the screenshot editor) ships behind the capture flag.
const flags = vi.hoisted(() => ({ capture: true }));
vi.mock("@/app/lib/featureFlags", () => ({
  get SCREEN_CAPTURE_ENABLED() {
    return flags.capture;
  },
}));

import TrayUploadRow from "../TrayUploadRow";
import { resetTrayThumbnails } from "../useTrayThumbnail";

const ACCOUNT = "5CPQ46eGx7nRkTyY2pV9wH3aLmZcQ1uS8bDfJ4kN6tWqFdJ";

function row(overrides: Partial<UploadFeedItem> = {}): UploadFeedItem {
  return {
    name: "report.pdf",
    actualFileName: "Work/report.pdf",
    size: 15_340_000,
    createdAt: Date.now() - 2 * 24 * 3600 * 1000,
    arionHash: "path-id",
    arionCid: "content-hash",
    fileId: "ab".repeat(32),
    minerIds: [],
    isAssigned: true,
    lastChargedAt: 0,
    isErasureCoded: false,
    mainReqHash: "",
    source: "/Users/me/Docs/Work/report.pdf",
    syncStatus: "synced",
    label: "Docs",
    feedStatus: "completed",
    ...overrides,
  };
}

/** A screenshot in the captures drive, on this computer. */
function screenshot(overrides: Partial<UploadFeedItem> = {}): UploadFeedItem {
  return row({
    name: "Screenshot 2026-10-06 at 10.00.00.png",
    actualFileName: "Screenshot 2026-10-06 at 10.00.00.png",
    size: 1_700_000,
    createdAt: Date.now() - 5 * 60 * 1000,
    source: "/Users/me/Captures/Screenshot 2026-10-06 at 10.00.00.png",
    label: "Captures",
    ...overrides,
  });
}

function renderRow(item: UploadFeedItem = row(), isCapture = false) {
  return render(
    <ul>
      <TrayUploadRow item={item} accountId={ACCOUNT} isCapture={isCapture} />
    </ul>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  emit.mockClear();
  resetTrayThumbnails();
  flags.capture = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hover actions", () => {
  it("are Copy link, Edit and the menu on a screenshot", () => {
    renderRow(screenshot(), true);
    const quick = screen.getByTestId("tray-row-quick-actions");
    expect(within(quick).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Copy link: Screenshot 2026-10-06 at 10.00.00.png",
      "Edit: Screenshot 2026-10-06 at 10.00.00.png",
    ]);
    // Copy link is the primary one, in brand blue, and says what it does.
    const copy = within(quick).getByRole("button", { name: /^Copy link/ });
    expect(copy).toHaveTextContent("Copy link");
    expect(copy.className).toContain("bg-primary-50");
    expect(
      screen.getByRole("button", { name: "More actions for Screenshot 2026-10-06 at 10.00.00.png" }),
    ).toBeInTheDocument();
  });

  it("offer Edit on pictures only", () => {
    renderRow(row());
    expect(screen.queryByRole("button", { name: /^Edit:/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link: report.pdf" })).toBeInTheDocument();
    cleanup();

    renderRow(screenshot({ name: "clip.mp4", actualFileName: "clip.mp4" }), true);
    expect(screen.queryByRole("button", { name: /^Edit:/ })).not.toBeInTheDocument();
    cleanup();

    // A picture with no copy on this computer cannot be edited in place.
    renderRow(screenshot({ source: "" }), true);
    expect(screen.queryByRole("button", { name: /^Edit:/ })).not.toBeInTheDocument();
    cleanup();

    // Nor where the lane has no screenshot editor.
    flags.capture = false;
    renderRow(screenshot(), true);
    expect(screen.queryByRole("button", { name: /^Edit:/ })).not.toBeInTheDocument();
  });

  it("take no room until the pointer or the keyboard arrives", () => {
    // Zero width while hidden, so the name has the row; still in the tab
    // order, and focus inside the row opens them.
    renderRow(screenshot(), true);
    const quick = screen.getByTestId("tray-row-quick-actions");
    expect(quick.className).toContain("max-w-0");
    expect(quick.className).toContain("opacity-0");
    expect(quick.className).toContain("group-hover:max-w-[180px]");
    expect(quick.className).toContain("group-focus-within:opacity-100");
  });

  it("are not offered while a file uploads; its progress is", () => {
    renderRow(
      row({ feedStatus: "uploading", syncStatus: "uploading", progressPercent: 40 }),
    );
    expect(screen.queryByTestId("tray-row-quick-actions")).not.toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("Edit hides the popover, then opens that file in the editor", async () => {
    renderRow(screenshot(), true);
    fireEvent.click(screen.getByRole("button", { name: /^Edit:/ }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("capture_editor_open_file", {
        label: "Captures",
        relativePath: "Screenshot 2026-10-06 at 10.00.00.png",
      }),
    );
    const names = invoke.mock.calls.map(([name]) => name);
    expect(names.indexOf("hide_tray_panel")).toBeLessThan(names.indexOf("capture_editor_open_file"));
  });
});

describe("row subtitle", () => {
  it("reads Screenshot or Recording for a capture, with size and time", () => {
    renderRow(screenshot(), true);
    expect(screen.getByText("Screenshot · 1.7 MB · 5m ago")).toBeInTheDocument();
    cleanup();
    renderRow(
      screenshot({ name: "Recording.mp4", actualFileName: "Recording.mp4", size: 20_200_000 }),
      true,
    );
    expect(screen.getByText("Recording · 20.2 MB · 5m ago")).toBeInTheDocument();
  });

  it("reads the file's type for anything else", () => {
    renderRow();
    expect(screen.getByText("PDF · 15.3 MB · 2d ago")).toBeInTheDocument();
  });
});

describe("row thumbnail", () => {
  it("shows the picture Rust made for a screenshot", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_tray_thumbnail"
        ? Promise.resolve({ path: "/Users/me/.hippius/thumbnail-cache/x.jpg", kind: "image", durationSecs: null })
        : Promise.resolve(undefined),
    );
    renderRow(screenshot(), true);
    const img = await screen.findByTestId("tray-row-thumbnail");
    expect(img).toHaveAttribute("src", "asset://localhost//Users/me/.hippius/thumbnail-cache/x.jpg");
    expect(screen.queryByTestId("tray-row-icon")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tray-row-play")).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("get_tray_thumbnail", {
      accountId: ACCOUNT,
      label: "Captures",
      fileId: "ab".repeat(32),
      arionHash: "content-hash",
      source: "/Users/me/Captures/Screenshot 2026-10-06 at 10.00.00.png",
      fileName: "Screenshot 2026-10-06 at 10.00.00.png",
      size: 1_700_000,
    });
  });

  it("marks a recording's frame with a play badge and its length", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_tray_thumbnail"
        ? Promise.resolve({ path: "/t/v.jpg", kind: "video", durationSecs: 42.4 })
        : Promise.resolve(undefined),
    );
    renderRow(screenshot({ name: "Recording.mp4", actualFileName: "Recording.mp4" }), true);
    await screen.findByTestId("tray-row-thumbnail");
    expect(screen.getByTestId("tray-row-play")).toBeInTheDocument();
    expect(screen.getByText("0:42")).toBeInTheDocument();
  });

  it("keeps the file-type icon when there is no picture", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_tray_thumbnail" ? Promise.resolve(null) : Promise.resolve(undefined),
    );
    renderRow();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_tray_thumbnail", expect.anything()));
    expect(screen.getByTestId("tray-row-icon")).toBeInTheDocument();
    expect(screen.queryByTestId("tray-row-thumbnail")).not.toBeInTheDocument();
  });

  it("falls back to the icon when the picture cannot load or be made", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_tray_thumbnail"
        ? Promise.resolve({ path: "/t/gone.jpg", kind: "image", durationSecs: null })
        : Promise.resolve(undefined),
    );
    renderRow(screenshot(), true);
    fireEvent.error(await screen.findByTestId("tray-row-thumbnail"));
    expect(screen.getByTestId("tray-row-icon")).toBeInTheDocument();
    cleanup();

    resetTrayThumbnails();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_tray_thumbnail" ? Promise.reject({ kind: "Hcfs", message: "offline" }) : Promise.resolve(undefined),
    );
    renderRow(screenshot(), true);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.getByTestId("tray-row-icon")).toBeInTheDocument();
    warn.mockRestore();
  });

  it("does not ask for a picture of a file still on its way", () => {
    renderRow(row({ feedStatus: "uploading", syncStatus: "uploading", progressPercent: 10 }));
    expect(invoke).not.toHaveBeenCalledWith("get_tray_thumbnail", expect.anything());
    expect(screen.getByTestId("tray-row-icon")).toBeInTheDocument();
  });
});

describe("copy link", () => {
  it("asks Rust for the link and says it was copied, then shows the time again", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "copy_file_share_link"
        ? Promise.resolve({ status: "copied", url: "https://x/#k=1", reused: false })
        : Promise.resolve(undefined),
    );
    renderRow();
    expect(screen.getByText("PDF · 15.3 MB · 2d ago")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link: report.pdf" }));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
    // A file on disk is shared from disk: no server id is sent.
    expect(invoke).toHaveBeenCalledWith("copy_file_share_link", {
      folderLabel: "Docs",
      relativePath: "Work/report.pdf",
      fileId: null,
    });
    await waitFor(() => expect(screen.getByText("PDF · 15.3 MB · 2d ago")).toBeInTheDocument());
  });

  it("sends the server id for a file with no copy on this computer", async () => {
    invoke.mockResolvedValue({ status: "copied", url: "u", reused: true });
    const cloud = row({ source: "", label: "Photos" });
    renderRow(cloud);
    fireEvent.click(screen.getByRole("button", { name: "Copy link: report.pdf" }));
    await screen.findByText("Link copied");
    expect(invoke).toHaveBeenCalledWith("copy_file_share_link", {
      folderLabel: "Photos",
      relativePath: "Work/report.pdf",
      fileId: cloud.fileId,
    });
  });

  it("shows Rust's sentence when no link could be made", async () => {
    invoke.mockResolvedValue({
      status: "failed",
      message: "You're offline. Create the link when you're back online.",
    });
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Copy link: report.pdf" }));
    expect(
      await screen.findByText("You're offline. Create the link when you're back online."),
    ).toBeInTheDocument();
  });

  it("does not start a second link while the first is being made", async () => {
    let resolve: (v: unknown) => void = () => {};
    invoke.mockImplementation((cmd: string) =>
      cmd === "copy_file_share_link" ? new Promise((r) => (resolve = r)) : Promise.resolve(null),
    );
    renderRow();
    const button = screen.getByRole("button", { name: "Copy link: report.pdf" });
    fireEvent.click(button);
    expect(await screen.findByText("Getting link…")).toBeInTheDocument();
    fireEvent.click(button);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "copy_file_share_link")).toHaveLength(1);
    resolve({ status: "copied", url: "u", reused: true });
    await screen.findByText("Link copied");
  });
});

describe("row menu", () => {
  const menuItems = () =>
    within(screen.getByRole("menu")).getAllByRole("menuitem").map((m) => m.textContent);

  it("opens from the three dots with the Drive's actions for a local file", () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
    expect(menuItems()).toEqual([
      "View",
      "Download",
      "Copy link",
      "Share via link…",
      "Show in Hippius",
      expect.stringMatching(/^Reveal in /),
      "Rename…",
      "Delete…",
    ]);
    // Focus moves into the menu for the keyboard.
    expect(document.activeElement).toHaveTextContent("View");
  });

  it("offers Edit image in the menu for a picture", () => {
    renderRow(screenshot(), true);
    fireEvent.click(
      screen.getByRole("button", { name: "More actions for Screenshot 2026-10-06 at 10.00.00.png" }),
    );
    expect(menuItems()).toContain("Edit image");
    expect(menuItems().indexOf("Edit image")).toBe(menuItems().indexOf("View") + 1);
  });

  it("opens the same menu on right click", () => {
    renderRow();
    fireEvent.contextMenu(screen.getByText("PDF · 15.3 MB · 2d ago"));
    expect(screen.getByRole("menu", { name: "Actions for report.pdf" })).toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the dots", () => {
    renderRow();
    const dots = screen.getByRole("button", { name: "More actions for report.pdf" });
    fireEvent.click(dots);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(dots);
  });

  it("moves through the items with the arrow keys", () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Download");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toHaveTextContent("Delete…");
  });

  it("hands Rename to the main window with the plain Drive file, then hides the popover", async () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    await waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        "hippius:tray-file-action",
        expect.objectContaining({ action: "rename" }),
      ),
    );
    const [, request] = emit.mock.calls[0] as unknown as [string, { file: Record<string, unknown> }];
    expect(request.file.actualFileName).toBe("Work/report.pdf");
    expect(request.file).not.toHaveProperty("feedStatus");
    expect(main.show).toHaveBeenCalled();
    expect(main.setFocus).toHaveBeenCalled();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("hide_tray_panel"));
  });

  it("reveals a local file in the file manager from the popover itself", async () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Reveal in / }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_path_in_file_manager", {
        path: "/Users/me/Docs/Work/report.pdf",
      }),
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("says so on the row when the file is not on this computer to reveal", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "reveal_path_in_file_manager" || cmd === "resolve_file_path"
        ? Promise.reject({ kind: "Io", message: "No such file" })
        : Promise.resolve(undefined),
    );
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Reveal in / }));
    expect(await screen.findByText("No such file")).toBeInTheDocument();
  });

  it("does nothing for a disabled item", () => {
    renderRow(row({ source: "", label: "Photos" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
    const rename = screen.getByRole("menuitem", { name: "Rename…" });
    expect(rename).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(rename);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(emit).not.toHaveBeenCalled();
  });
});
