// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const checkForUpdate = vi.hoisted(() => vi.fn());
const installUpdate = vi.hoisted(() => vi.fn());
const restartBlockers = vi.hoisted(() => vi.fn());
const relaunch = vi.hoisted(() => vi.fn());
const startRestartWhenDone = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri/updates", () => ({
  checkForUpdate,
  installUpdate,
  restartBlockers,
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.6.25") }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Exit animations never finish under fake timers; render each state plainly.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const strip = (props: Record<string, unknown>) => {
    const { initial, animate, exit, transition, ...rest } = props;
    void initial;
    void animate;
    void exit;
    void transition;
    return rest;
  };
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        const Plain = React.forwardRef<HTMLElement, Record<string, unknown>>(
          (props, ref) => React.createElement(tag, { ...strip(props), ref }),
        );
        Plain.displayName = `motion.${tag}`;
        return Plain;
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});
vi.mock("../autoRestart", async (orig) => ({
  ...(await orig<typeof import("../autoRestart")>()),
  startRestartWhenDone,
}));

import UpdateDialog from "../UpdateDialog";
import { AUTO_RESTART_DELAY_MS } from "../autoRestart";
import { closeUpdateDialog, openUpdateDialog, updateDialogOpenAtom, updateStore } from "../updateStore";

const update = {
  version: "0.6.26",
  currentVersion: "0.6.25",
  notes: "Faster links",
  channel: "production",
  installInPlace: true,
  releasePageUrl: "https://example.invalid/release",
  manualInstallHint: "Download it.",
};

/** Let pending promises and the fake install phases run. */
async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function installTheUpdate() {
  render(<UpdateDialog />);
  act(() => openUpdateDialog({ version: update.version, body: update.notes }));
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  // Download resolves at once; the install phases take 5 x 500 ms.
  await flush(2600);
}

describe("UpdateDialog restarts by itself", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checkForUpdate.mockResolvedValue(update);
    installUpdate.mockResolvedValue(undefined);
    relaunch.mockResolvedValue(undefined);
    restartBlockers.mockResolvedValue([]);
    startRestartWhenDone.mockResolvedValue("restarted");
  });

  afterEach(() => {
    cleanup();
    act(() => closeUpdateDialog());
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("says before installing that it will restart by itself", async () => {
    render(<UpdateDialog />);
    act(() => openUpdateDialog({ version: update.version, body: update.notes }));
    await flush();
    expect(
      screen.getByText("Hippius restarts by itself when the update is installed."),
    ).toBeTruthy();
  });

  it("shows Restarting and relaunches with no button press when nothing is running", async () => {
    await installTheUpdate();

    expect(screen.getByRole("heading", { level: 1, name: "Restarting Hippius" })).toBeTruthy();
    expect(screen.getByTestId("update-restarting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart App" })).toBeNull();
    expect(relaunch).not.toHaveBeenCalled();

    await flush(AUTO_RESTART_DELAY_MS);
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("asks first when a recording is running, in Rust's words", async () => {
    restartBlockers.mockResolvedValue([
      { kind: "recording", line: "A screen recording is in progress." },
    ]);
    await installTheUpdate();
    await flush(AUTO_RESTART_DELAY_MS);

    expect(screen.getByText("A screen recording is in progress.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart when done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart now" })).toBeTruthy();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("Restart now relaunches at once", async () => {
    restartBlockers.mockResolvedValue([
      { kind: "editorOpen", line: "A picture is open in the editor." },
    ]);
    await installTheUpdate();

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await flush();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("Restart when done closes the dialog and waits for Rust to say the work is finished", async () => {
    restartBlockers.mockResolvedValue([
      { kind: "transfer", line: "Files are still uploading or downloading." },
    ]);
    await installTheUpdate();

    fireEvent.click(screen.getByRole("button", { name: "Restart when done" }));
    await flush();

    expect(updateStore.get(updateDialogOpenAtom)).toBe(false);
    expect(startRestartWhenDone).toHaveBeenCalledOnce();
    const deps = startRestartWhenDone.mock.calls[0][0];
    expect(deps.getBlockers).toBe(restartBlockers);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("falls back to the Restart App button when the relaunch fails", async () => {
    relaunch.mockRejectedValue(new Error("no"));
    await installTheUpdate();
    await flush(AUTO_RESTART_DELAY_MS);

    expect(screen.getByRole("button", { name: "Restart App" })).toBeTruthy();
  });
});
