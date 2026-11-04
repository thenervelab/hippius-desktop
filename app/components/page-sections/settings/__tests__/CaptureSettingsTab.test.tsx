import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";
import { serverCapabilitiesAtom } from "@/app/lib/global-atoms/sharesAtoms";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);
vi.mock("@/app/lib/featureFlags", () => ({ SCREEN_CAPTURE_ENABLED: true }));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/lib/capture/shortcutLabel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/capture/shortcutLabel")>()),
  isMacPlatform: () => true,
}));

import CaptureSettings from "../CaptureSettings";
import {
  captureRecordingAtom,
  captureRecordingNoteAtom,
  captureSupportedAtom,
  captureSurfacesAtom,
} from "@/app/lib/capture/captureFlow";
import type { CaptureOptions, CaptureSurfaces } from "@/app/lib/tauri/capture";
import { LOCKED_ACTION, LOCKED_PROMPT } from "@/components/page-sections/shares/insights/insightsView";

const SCREENSHOT_DEFAULT = "CommandOrControl+Shift+2";
const RECORD_DEFAULT = "CommandOrControl+Alt+Shift+2";
const TAKEN = "Those keys already take a screenshot. Choose different keys for recording.";

const OPTIONS: CaptureOptions = {
  timerSecs: 0,
  microphone: true,
  microphoneDevice: null,
  screen: true,
  camera: false,
  cameraDevice: null,
  cameraSize: "small",
  showClicks: false,
  systemAudio: false,
  lastKind: "screenshot",
  lastMode: "area",
  copyLink: true,
  openLink: true,
  chatPreview: true,
  linkInsights: true,
  recordCountdownSecs: 3,
};

const MAC: CaptureSurfaces = {
  selection: "overlay",
  modes: { screenshot: ["area", "window", "screen"], recording: ["area", "window", "screen"] },
  screenshotTimer: true,
  recordCountdown: true,
  systemAudio: true,
  microphoneUnavailableMessage: null,
  continuityHint: null,
  shortcut: { supported: true, via: "plugin", unavailableMessage: null, command: null },
  recordShortcut: { supported: true, via: "plugin", unavailableMessage: null, command: null },
  systemPickerNote: null,
  linuxSession: null,
};

type Kind = "screenshot" | "record";
let shortcuts: Record<Kind, string | null>;
let stored: CaptureOptions;

function setup({
  recording = true,
  surfaces = MAC,
  insights = false,
  plan = true,
}: { recording?: boolean; surfaces?: CaptureSurfaces; insights?: boolean; plan?: boolean | null } = {}) {
  tauri.onInvoke("share_switches_in_plan", () => plan);
  tauri.onInvoke("capture_get_shortcut", (args) => {
    const kind: Kind = (args as { kind?: Kind } | undefined)?.kind ?? "screenshot";
    return {
      accelerator: shortcuts[kind],
      defaultAccelerator: kind === "record" ? RECORD_DEFAULT : SCREENSHOT_DEFAULT,
    };
  });
  tauri.onInvoke("capture_set_shortcut", (args) => {
    const { accelerator, kind = "screenshot" } = args as { accelerator: string | null; kind?: Kind };
    shortcuts[kind] = accelerator;
    return null;
  });
  tauri.onInvoke("capture_drive_status", () => ({ state: "needsSetup", suggested: { path: "/x", place: "Documents" }, waiting: 0 }));
  tauri.onInvoke("capture_editor_save_preference", () => "ask");
  tauri.onInvoke("capture_get_options", () => stored);
  tauri.onInvoke("capture_set_options", (args) => {
    stored = { ...(args as { options: CaptureOptions }).options };
    return { options: stored, countdownSecs: 3, cameraFilmed: true };
  });
  const store = createStore();
  store.set(captureSupportedAtom, true);
  store.set(captureRecordingAtom, recording);
  store.set(captureRecordingNoteAtom, null);
  store.set(captureSurfacesAtom, surfaces);
  store.set(serverCapabilitiesAtom, { shares: true, share_insights: insights } as ServerCapabilities);
  return render(
    <Provider store={store}>
      <CaptureSettings />
    </Provider>,
  );
}

const card = (name: string) => screen.findByRole("group", { name });

beforeEach(() => {
  tauri.reset();
  shortcuts = { screenshot: SCREENSHOT_DEFAULT, record: RECORD_DEFAULT };
  stored = { ...OPTIONS };
});

describe("the Screenshots & Recording tab", () => {
  it("lists the shortcuts first, Record before Screenshot, then the folder, then the editor's save", async () => {
    const { container } = setup();
    await card("Recording shortcut");
    await screen.findByText("Copy a share link after capture");
    const text = container.textContent ?? "";
    const order = ["Recording shortcut", "Screenshot shortcut", "Capture folder", "When saving an edited image"].map(
      (t) => text.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  // Four labelled groups, so a setting is found by what it is about rather
  // than by scanning a grid of equal cards.
  it("puts every setting in its group: Shortcuts, Saving, Sharing, Recording", async () => {
    setup();
    await screen.findByRole("switch", { name: "Copy a share link after capture" });
    const groups = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(groups).toEqual(["Shortcuts", "Saving", "Sharing", "Recording"]);
    const group = (name: string) => screen.getByRole("region", { name });
    expect(within(group("Shortcuts")).getByRole("group", { name: "Recording shortcut" })).toBeInTheDocument();
    expect(within(group("Shortcuts")).getByRole("group", { name: "Screenshot shortcut" })).toBeInTheDocument();
    expect(within(group("Saving")).getByText("Capture folder")).toBeInTheDocument();
    expect(within(group("Saving")).getByRole("switch", { name: "Also save a copy to the Desktop" })).toBeInTheDocument();
    expect(within(group("Saving")).getByRole("group", { name: "When saving an edited image" })).toBeInTheDocument();
    expect(within(group("Sharing")).getByRole("switch", { name: "Open the link in your browser" })).toBeInTheDocument();
    expect(within(group("Sharing")).getByRole("switch", { name: "Show a preview in chats" })).toBeInTheDocument();
    expect(within(group("Recording")).getByRole("group", { name: "Recording countdown" })).toBeInTheDocument();
    expect(within(group("Recording")).getByRole("switch", { name: "Record system audio" })).toBeInTheDocument();
  });

  // A dependent row is indented under its parent but drawn like every other
  // row: its own icon chip, no background of its own.
  it("draws the dependent rows with an icon like the rows they belong to", async () => {
    stored = { ...OPTIONS, desktopCopy: true };
    setup();
    for (const name of ["Save a copy of recordings to the Desktop", "Open the link in your browser"]) {
      const row = (await screen.findByRole("switch", { name })).closest("[data-setting-row]") as HTMLElement;
      expect(row).toHaveAttribute("data-setting-row", "sub");
      expect(row.querySelector("[aria-hidden] svg")).not.toBeNull();
      expect(row.className).not.toMatch(/\bbg-|dark:bg-/);
    }
  });

  it("has no Recording group where this computer cannot record", async () => {
    setup({ recording: false });
    await screen.findByRole("switch", { name: "Copy a share link after capture" });
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Shortcuts", "Saving", "Sharing"]);
  });

  it("offers no recording shortcut where this computer cannot record", async () => {
    setup({ recording: false });
    await card("Screenshot shortcut");
    expect(screen.queryByRole("group", { name: "Recording shortcut" })).toBeNull();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_get_shortcut", { kind: "record" });
  });
});

describe("the recording shortcut", () => {
  it("shows the screenshot keys plus Option by default", async () => {
    setup();
    const record = await card("Recording shortcut");
    await waitFor(() => expect(within(record).getByLabelText("Shortcut ⌥ ⇧ ⌘ 2")).toBeInTheDocument());
    expect(within(record).getByText(/open the capture bar ready to record/)).toBeInTheDocument();
  });

  it("records new keys and saves them as the recording shortcut, leaving the screenshot one alone", async () => {
    setup();
    const record = await card("Recording shortcut");
    fireEvent.click(within(record).getByRole("button", { name: "Change" }));
    fireEvent.keyDown(window, { code: "KeyR", key: "r", metaKey: true, altKey: true });
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: "Alt+Command+R", kind: "record" }),
    );
    expect(shortcuts.screenshot).toBe(SCREENSHOT_DEFAULT);
  });

  it("turns off on its own", async () => {
    setup();
    const record = await card("Recording shortcut");
    fireEvent.click(await within(record).findByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_shortcut", { accelerator: null, kind: "record" }),
    );
    await waitFor(() => expect(within(record).getByText("Off")).toBeInTheDocument());
    // The screenshot shortcut is still on.
    const screenshot = await card("Screenshot shortcut");
    expect(within(screenshot).getByRole("button", { name: "Turn off" })).toBeInTheDocument();
  });

  // Rust refuses the screenshot's keys; the card says so in Rust's words.
  it("says why when its keys are the screenshot shortcut's", async () => {
    setup();
    tauri.onInvoke("capture_set_shortcut", () => {
      throw { kind: "Validation", message: TAKEN };
    });
    const record = await card("Recording shortcut");
    fireEvent.click(within(record).getByRole("button", { name: "Change" }));
    await act(async () => {
      fireEvent.keyDown(window, { code: "Digit2", key: "2", metaKey: true, shiftKey: true });
    });
    expect(await within(record).findByRole("alert")).toHaveTextContent(TAKEN);
    expect(within(await card("Screenshot shortcut")).queryByRole("alert")).toBeNull();
  });

  // Wayland: the desktop holds it; the card gives the command to bind.
  it("gives the command to bind where the desktop holds the shortcut", async () => {
    const line = "Hippius can't set this shortcut on your desktop. Add one in your desktop's keyboard settings that runs this command:";
    setup({
      surfaces: {
        ...MAC,
        linuxSession: "wayland",
        recordShortcut: { supported: false, via: "desktopSettings", unavailableMessage: line, command: "/usr/bin/hippius --record" },
      },
    });
    const record = await card("Recording shortcut");
    expect(within(record).getByText(line)).toBeInTheDocument();
    expect(within(record).getByTestId("record-shortcut-command")).toHaveTextContent("/usr/bin/hippius --record");
    expect(within(record).queryByRole("button", { name: "Change" })).toBeNull();
    expect(within(record).queryByRole("button", { name: "Add for me" })).toBeNull();
  });
});

describe("the capture bar's options, here as well", () => {
  it("turns copying a share link off through Rust's own options, keeping the rest", async () => {
    stored = { ...OPTIONS, microphoneDevice: "usb-mic" };
    setup();
    fireEvent.click(await screen.findByRole("switch", { name: "Copy a share link after capture" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: { ...OPTIONS, microphoneDevice: "usb-mic", copyLink: false },
      }),
    );
    // Opening the link means nothing without one.
    await waitFor(() => expect(screen.queryByRole("switch", { name: "Open the link in your browser" })).toBeNull());
  });

  it("turns showing a preview in chats off and on, saved with the rest of the options", async () => {
    setup();
    const preview = await screen.findByRole("switch", { name: "Show a preview in chats" });
    expect(preview).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/The preview picture and file name aren't encrypted\./)).toBeInTheDocument();
    fireEvent.click(preview);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: { ...OPTIONS, chatPreview: false },
      }),
    );
    await waitFor(() => expect(stored.chatPreview).toBe(false));
    expect(screen.getByRole("switch", { name: "Show a preview in chats" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("switch", { name: "Show a preview in chats" }));
    await waitFor(() => expect(stored.chatPreview).toBe(true));
  });

  it("turns tracking views, comments and reactions off for captures, once the server has insights", async () => {
    setup({ insights: true });
    const track = await screen.findByRole("switch", { name: "Track views, comments and reactions" });
    expect(track).toHaveAttribute("aria-checked", "true");
    fireEvent.click(track);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: { ...OPTIONS, linkInsights: false },
      }),
    );
    await waitFor(() => expect(stored.linkInsights).toBe(false));
  });

  it("shows tracking as a paid feature on the free plan, with the upgrade prompt instead of a switch", async () => {
    setup({ insights: true, plan: false });
    expect(
      await screen.findByText(
        "Links to your screenshots and recordings count how many people view them and for how long, and let viewers comment and react. On paid Drive plans.",
      ),
    ).toBeInTheDocument();
    const track = screen.getByRole("switch", { name: "Track views, comments and reactions" });
    // Off whatever is stored: new links on the free plan get none of the three.
    expect(stored.linkInsights).toBe(true);
    expect(track).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();

    fireEvent.click(track);
    const prompt = screen.getByRole("region", { name: "Upgrade for Insights, comments and reactions" });
    expect(prompt).toHaveTextContent(LOCKED_PROMPT);
    expect(track).toHaveAttribute("aria-checked", "false");
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("capture_set_options", expect.anything());

    fireEvent.click(within(prompt).getByRole("button", { name: LOCKED_ACTION }));
    expect(push).toHaveBeenCalledWith("/billing");
  });

  it("keeps the plain switch when the plan could not be read", async () => {
    setup({ insights: true, plan: null });
    const track = await screen.findByRole("switch", { name: "Track views, comments and reactions" });
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("share_switches_in_plan"));
    expect(track).toHaveAttribute("aria-checked", "true");
    fireEvent.click(track);
    await waitFor(() => expect(stored.linkInsights).toBe(false));
    expect(screen.queryByText(LOCKED_PROMPT)).toBeNull();
  });

  it("does not offer tracking on a server without insights", async () => {
    setup({ insights: false });
    await screen.findByRole("switch", { name: "Show a preview in chats" });
    expect(screen.queryByRole("switch", { name: "Track views, comments and reactions" })).toBeNull();
  });

  // It is also where the share dialog's switch starts for a capture, so it
  // stays offered when links are not copied after a capture.
  it("keeps the chat preview choice when links are not copied", async () => {
    stored = { ...OPTIONS, copyLink: false };
    setup();
    expect(await screen.findByRole("switch", { name: "Show a preview in chats" })).toBeInTheDocument();
  });

  it("sets the recording countdown and system audio where this computer records", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "5 seconds" }));
    await waitFor(() => expect(stored.recordCountdownSecs).toBe(5));
    fireEvent.click(screen.getByRole("switch", { name: "Record system audio" }));
    await waitFor(() => expect(stored.systemAudio).toBe(true));
  });

  it("saves a copy of screenshots to the Desktop when asked, and of recordings as a second choice", async () => {
    setup();
    const desktop = await screen.findByRole("switch", { name: "Also save a copy to the Desktop" });
    expect(desktop).toHaveAttribute("aria-checked", "false");
    // Recordings are a choice under it, shown only once copies are on.
    expect(screen.queryByRole("switch", { name: "Save a copy of recordings to the Desktop" })).toBeNull();
    fireEvent.click(desktop);
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("capture_set_options", {
        options: { ...OPTIONS, desktopCopy: true },
      }),
    );
    const recordings = await screen.findByRole("switch", { name: "Save a copy of recordings to the Desktop" });
    expect(recordings).toHaveAttribute("aria-checked", "false");
    fireEvent.click(recordings);
    await waitFor(() => expect(stored.desktopCopyRecordings).toBe(true));
    expect(stored.desktopCopy).toBe(true);
  });

  it("offers only the link options where this computer cannot record", async () => {
    setup({ recording: false });
    expect(await screen.findByRole("switch", { name: "Copy a share link after capture" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Recording countdown" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Record system audio" })).toBeNull();
  });

  it("offers the Desktop copy for screenshots only where this computer cannot record", async () => {
    stored = { ...OPTIONS, desktopCopy: true };
    setup({ recording: false });
    expect(await screen.findByRole("switch", { name: "Also save a copy to the Desktop" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("switch", { name: "Save a copy of recordings to the Desktop" })).toBeNull();
  });
});
