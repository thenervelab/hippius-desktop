import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
  configure,
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
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => emit(...(args as [])),
}));
vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: vi.fn(() => Promise.resolve(main)) },
}));

import TrayUploadRow from "../TrayUploadRow";

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

function renderRow(item: UploadFeedItem = row()) {
  return render(
    <ul>
      <TrayUploadRow item={item} accountId={ACCOUNT} />
    </ul>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  emit.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("hover quick actions", () => {
  it("names every icon button and gives it a tooltip", () => {
    renderRow();
    const quick = screen.getByTestId("tray-row-quick-actions");
    const buttons = within(quick).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual([
      "Show in Hippius",
      "Copy link",
      "View",
    ]);
    expect(
      within(quick).getByRole("button", { name: "Copy link: report.pdf" }),
    ).toBeInTheDocument();
  });

  it("are laid out while hidden, so hovering never moves the row", () => {
    // Hidden by opacity, not removed: the row keeps its height and the size
    // does not shift when the pointer arrives. Reachable by keyboard too.
    renderRow();
    const quick = screen.getByTestId("tray-row-quick-actions");
    expect(quick.className).toContain("opacity-0");
    expect(quick.className).toContain("group-hover:opacity-100");
    expect(quick.className).toContain("group-focus-within:opacity-100");
  });

  it("are only the folder button while a file uploads", () => {
    renderRow(
      row({ feedStatus: "uploading", syncStatus: "uploading", progressPercent: 40 }),
    );
    const quick = screen.getByTestId("tray-row-quick-actions");
    expect(within(quick).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("40%")).toBeInTheDocument();
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
    expect(screen.getByText("2d ago")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy link: report.pdf" }));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
    // A file on disk is shared from disk: no server id is sent.
    expect(invoke).toHaveBeenCalledWith("copy_file_share_link", {
      folderLabel: "Docs",
      relativePath: "Work/report.pdf",
      fileId: null,
    });
    await waitFor(() => expect(screen.getByText("2d ago")).toBeInTheDocument());
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
    invoke.mockImplementation(() => new Promise((r) => (resolve = r)));
    renderRow();
    const button = screen.getByRole("button", { name: "Copy link: report.pdf" });
    fireEvent.click(button);
    expect(await screen.findByText("Getting link…")).toBeInTheDocument();
    fireEvent.click(button);
    expect(invoke).toHaveBeenCalledTimes(1);
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

  it("opens the same menu on right click", () => {
    renderRow();
    fireEvent.contextMenu(screen.getByText("15.34 MB"));
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
