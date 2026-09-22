import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import type { MatrixClient } from "matrix-js-sdk";

import { CHAT_SIGN_OUT_CONFIRM } from "@/lib/chat/sign-out";

/**
 * The Preferences dialog is where a user changes what the app does on
 * their behalf, so the tests pin the behaviour behind each control: the
 * sign-out never fires without the confirm, the notification switches are
 * Rust preferences (read on open, written on toggle, rolled back when the
 * write fails), the recovery key is only derived when asked for, and the
 * device list marks this device and lets it be renamed.
 */

const signOut = vi.fn(async () => undefined);
const unlockEncryption = vi.fn();
const repairEncryption = vi.fn();
let encryption: { kind: string; [k: string]: unknown } = { kind: "unknown" };
vi.mock("@/components/chat/ChatProvider", () => ({
  useChat: () => ({ signOut, unlockEncryption, repairEncryption, encryption }),
}));

const openExternalLink = vi.fn<(url: string) => Promise<void>>(async () => undefined);
vi.mock("@/app/lib/utils/tauri", () => ({
  openExternalLink: (url: string) => openExternalLink(url),
}));

const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

vi.mock("@/components/chat/UserAvatar", () => ({ default: () => <div data-testid="avatar" /> }));
vi.mock("@/components/chat/EncryptionDiagnostics", () => ({ default: () => null }));

const prefs = {
  getNotifications: vi.fn(async () => true),
  setNotifications: vi.fn<(enabled: boolean) => Promise<void>>(async () => undefined),
  getSound: vi.fn(async () => true),
  setSound: vi.fn<(enabled: boolean) => Promise<void>>(async () => undefined),
};
vi.mock("@/lib/tauri/chat", () => ({
  chatGetNotificationsEnabled: () => prefs.getNotifications(),
  chatSetNotificationsEnabled: (v: boolean) => prefs.setNotifications(v),
  chatGetSoundEnabled: () => prefs.getSound(),
  chatSetSoundEnabled: (v: boolean) => prefs.setSound(v),
}));

const recoveryKeyText = vi.fn(async () => "EsTc abcd efgh ijkl");
vi.mock("@/lib/chat/settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chat/settings")>("@/lib/chat/settings");
  return { ...actual, recoveryKeyText: () => recoveryKeyText() };
});

const { default: ChatSettingsDialog } = await import("@/components/chat/ChatSettingsDialog");
const { chatSettingsOpenAtom } = await import("@/components/chat/chat-ui-atoms");

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getUserId: () => "@alice:hippius.com",
    getDeviceId: () => "DEV1",
    getCrypto: () => undefined,
    getUser: () => ({ displayName: "Alice", avatarUrl: null }),
    getAuthMetadata: vi.fn(async () => ({ account_management_uri: "https://auth.hippius.com/account/" })),
    setDisplayName: vi.fn(async () => ({})),
    getDevices: vi.fn(async () => ({
      devices: [
        { device_id: "OLD", display_name: "Old laptop", last_seen_ts: 1_000 },
        { device_id: "DEV1", display_name: "Desktop", last_seen_ts: 2_000 },
      ],
    })),
    setDeviceDetails: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as MatrixClient;
}

function renderOpen(client: MatrixClient, tab: "account" | "notifications" | "encryption" | "devices" = "account") {
  const store = createStore();
  store.set(chatSettingsOpenAtom, tab);
  render(
    <Provider store={store}>
      <ChatSettingsDialog client={client} />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  signOut.mockClear();
  unlockEncryption.mockClear();
  repairEncryption.mockClear();
  openExternalLink.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  recoveryKeyText.mockClear();
  prefs.getNotifications.mockReset().mockResolvedValue(true);
  prefs.setNotifications.mockReset().mockResolvedValue(undefined);
  prefs.getSound.mockReset().mockResolvedValue(true);
  prefs.setSound.mockReset().mockResolvedValue(undefined);
  encryption = { kind: "unknown" };
});

describe("ChatSettingsDialog / Account", () => {
  it("shows who is signed in and signs out only after the confirm, then closes", async () => {
    const store = renderOpen(makeClient());
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("@alice:hippius.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out of chat" }));
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByText(CHAT_SIGN_OUT_CONFIRM)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(store.get(chatSettingsOpenAtom)).toBe(false));
  });

  it("opens the IdP sessions page in the system browser for other devices", async () => {
    renderOpen(makeClient());
    fireEvent.click(await screen.findByRole("button", { name: "Sign out other devices" }));
    expect(openExternalLink).toHaveBeenCalledWith("https://auth.hippius.com/account/?action=org.matrix.sessions_list");
  });

  it("renames the display name through the client and confirms with a toast", async () => {
    const client = makeClient();
    renderOpen(client);
    fireEvent.click(screen.getByRole("button", { name: "Edit display name" }));
    const input = screen.getByRole("textbox", { name: "Display name" });
    fireEvent.change(input, { target: { value: "Alice B." } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.setDisplayName).toHaveBeenCalledWith("Alice B."));
    expect(toast.success).toHaveBeenCalledWith("Display name updated");
  });
});

describe("ChatSettingsDialog / Notifications", () => {
  it("reads both switches from Rust and writes a toggle back", async () => {
    prefs.getSound.mockResolvedValue(false);
    renderOpen(makeClient(), "notifications");
    const notify = await screen.findByRole("switch", { name: "Desktop notifications" });
    const sound = screen.getByRole("switch", { name: "Notification sound" });
    await waitFor(() => expect(notify).toHaveAttribute("aria-checked", "true"));
    expect(sound).toHaveAttribute("aria-checked", "false");

    fireEvent.click(sound);
    expect(prefs.setSound).toHaveBeenCalledWith(true);
    expect(sound).toHaveAttribute("aria-checked", "true");
  });

  it("rolls a toggle back when Rust refuses the write", async () => {
    prefs.setNotifications.mockRejectedValue(new Error("db locked"));
    renderOpen(makeClient(), "notifications");
    const notify = await screen.findByRole("switch", { name: "Desktop notifications" });
    await waitFor(() => expect(notify).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(notify);
    await waitFor(() => expect(notify).toHaveAttribute("aria-checked", "true"));
    expect(toast.error).toHaveBeenCalled();
  });
});

describe("ChatSettingsDialog / Encryption", () => {
  it("offers set-up when encryption is not configured, and derives the recovery key only on request", async () => {
    renderOpen(makeClient(), "encryption");
    fireEvent.click(screen.getByRole("button", { name: "Set up encryption" }));
    expect(unlockEncryption).toHaveBeenCalledTimes(1);

    expect(recoveryKeyText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reveal recovery key" }));
    expect(await screen.findByText("EsTc abcd efgh ijkl")).toBeInTheDocument();
    expect(recoveryKeyText).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Hide recovery key" }));
    expect(screen.queryByText("EsTc abcd efgh ijkl")).toBeNull();
    // Showing it again reuses the derived text rather than asking Rust twice.
    fireEvent.click(screen.getByRole("button", { name: "Show recovery key" }));
    expect(screen.getByText("EsTc abcd efgh ijkl")).toBeInTheDocument();
    expect(recoveryKeyText).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation before resetting cross-signing on a foreign key", () => {
    encryption = { kind: "foreign-key", keyId: "k", keyName: "Element", canAdopt: false };
    renderOpen(makeClient(), "encryption");
    fireEvent.click(screen.getByRole("button", { name: "Reset encryption for this account" }));
    expect(repairEncryption).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));
    expect(repairEncryption).toHaveBeenCalledWith("reset-cross-signing");
  });

  it("adopts the derived key without a confirm when this device holds the signing keys", () => {
    encryption = { kind: "foreign-key", keyId: "k", canAdopt: true };
    renderOpen(makeClient(), "encryption");
    fireEvent.click(screen.getByRole("button", { name: "Use my Hippius key" }));
    expect(repairEncryption).toHaveBeenCalledWith("adopt-derived-key");
  });
});

describe("ChatSettingsDialog / Devices", () => {
  it("lists this device first, marks it, and renames it through the client", async () => {
    const client = makeClient();
    renderOpen(client, "devices");
    const items = await screen.findAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Desktop");
    expect(items[0]).toHaveTextContent("This device");
    expect(items[1]).toHaveTextContent("Old laptop");
    expect(items[1]).not.toHaveTextContent("This device");

    fireEvent.click(screen.getByRole("button", { name: "Rename this device" }));
    const input = screen.getByRole("textbox", { name: "Device name" });
    fireEvent.change(input, { target: { value: "Work desktop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(client.setDeviceDetails).toHaveBeenCalledWith("DEV1", { display_name: "Work desktop" }));
  });
});
