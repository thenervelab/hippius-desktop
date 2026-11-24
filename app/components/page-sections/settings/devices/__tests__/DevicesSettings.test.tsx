// Settings › Devices against a mocked Rust: every state the list can be in,
// this computer's row (pill, no Unlink), and an unlink from confirm to the row
// leaving the list without asking Rust for the list again.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { AccountDevice, DeviceListing } from "@/app/lib/tauri/devices";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Account" }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import DevicesSettings from "../DevicesSettings";

const NOW_S = Math.floor(Date.now() / 1000);

function device(overrides: Partial<AccountDevice>): AccountDevice {
  return {
    deviceId: "0".repeat(32),
    platform: "macos",
    platformName: "Mac",
    kind: "computer",
    label: "Studio",
    createdAt: NOW_S - 86_400 * 30,
    lastActiveAt: NOW_S,
    isThisDevice: false,
    ...overrides,
  };
}

const THIS = device({ deviceId: "a".repeat(32), label: "Desk Mac", isThisDevice: true });
const PHONE = device({
  deviceId: "b".repeat(32),
  platform: "ios",
  platformName: "iPhone",
  kind: "phone",
  label: "iPhone 15 Pro",
});
const LAPTOP = device({ deviceId: "c".repeat(32), platform: "windows", platformName: "Windows", label: "Work PC" });

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return { client, ...render(
    <QueryClientProvider client={client}>
      <DevicesSettings />
    </QueryClientProvider>,
  ) };
}

function listCalls() {
  return tauri.core.invoke.mock.calls.filter(([command]) => command === "list_account_devices").length;
}

beforeEach(() => {
  tauri.reset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("DevicesSettings", () => {
  it("shows skeleton rows until Rust answers", async () => {
    let answer: (listing: DeviceListing) => void = () => {};
    tauri.onInvoke("list_account_devices", () => new Promise<DeviceListing>((resolve) => (answer = resolve)));
    renderSection();
    expect(screen.getAllByTestId("device-row-skeleton").length).toBeGreaterThan(0);
    answer({ available: true, devices: [THIS] });
    expect(await screen.findByText("Desk Mac")).toBeInTheDocument();
    expect(screen.queryByTestId("device-row-skeleton")).not.toBeInTheDocument();
  });

  it("lists this computer first with a pill and no Unlink, and the rest with Unlink", async () => {
    tauri.onInvoke("list_account_devices", (args) => {
      expect(args).toEqual({ accountId: "5Account" });
      return { available: true, devices: [THIS, PHONE, LAPTOP] };
    });
    renderSection();
    const rows = await screen.findAllByTestId("device-row");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Desk Mac", "iPhone 15 Pro", "Work PC"]);

    const mine = within(rows[0]);
    expect(mine.getByText("This device")).toBeInTheDocument();
    expect(mine.queryByRole("button", { name: /unlink/i })).not.toBeInTheDocument();
    expect(mine.getByText("Mac · Active today")).toBeInTheDocument();

    expect(within(rows[1]).getByRole("button", { name: "Unlink iPhone 15 Pro" })).toBeInTheDocument();
    expect(within(rows[1]).queryByText("This device")).not.toBeInTheDocument();
    expect(within(rows[1]).getByText("iPhone · Active today")).toBeInTheDocument();
  });

  it("says when no device is linked yet", async () => {
    tauri.onInvoke("list_account_devices", () => ({ available: true, devices: [] }));
    renderSection();
    expect(
      await screen.findByText("No devices yet. A phone or computer shows here once it signs in."),
    ).toBeInTheDocument();
  });

  it("says Devices aren't available, with nothing to retry, when the server refuses them", async () => {
    tauri.onInvoke("list_account_devices", () => ({ available: false, devices: [] }));
    renderSection();
    expect(await screen.findByText("Devices aren't available on this account yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });

  it("offers Try again when the list could not be read, and lists after it", async () => {
    let failing = true;
    tauri.onInvoke("list_account_devices", () => {
      if (failing) throw { kind: "Other", message: "Hippius didn't answer." };
      return { available: true, devices: [THIS, PHONE] };
    });
    renderSection();
    expect(await screen.findByText("Couldn't load your devices.")).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText("iPhone 15 Pro")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your devices.")).not.toBeInTheDocument();
  });

  it("confirms a phone unlink with what the phone loses, then drops the row without listing again", async () => {
    tauri.onInvoke("list_account_devices", () => ({ available: true, devices: [THIS, PHONE, LAPTOP] }));
    const unlinked: unknown[] = [];
    tauri.onInvoke("unlink_account_device", (args) => {
      unlinked.push(args);
      return null;
    });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Unlink iPhone 15 Pro" }));

    expect(await screen.findByText("Unlink iPhone 15 Pro?")).toBeInTheDocument();
    // A phone is told what it loses, not that it is signed out.
    expect(screen.queryByText(/signed out/)).not.toBeInTheDocument();
    expect(screen.getByText("Files kept offline on it are deleted from it.")).toBeInTheDocument();
    expect(screen.getByText("Camera Uploads stops on it.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Everything it uploaded stays in your drive. Sign in on it again anytime, and its backup continues where it left off.",
      ),
    ).toBeInTheDocument();
    const before = listCalls();

    fireEvent.click(screen.getByRole("button", { name: /^unlink$/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('"iPhone 15 Pro" unlinked'));
    expect(unlinked).toEqual([{ accountId: "5Account", deviceId: PHONE.deviceId }]);
    await waitFor(() => expect(screen.queryByText("iPhone 15 Pro")).not.toBeInTheDocument());
    expect(screen.getByText("Work PC")).toBeInTheDocument();
    expect(listCalls()).toBe(before);
  });

  it("tells a computer it stops syncing", async () => {
    tauri.onInvoke("list_account_devices", () => ({ available: true, devices: [THIS, LAPTOP] }));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Unlink Work PC" }));
    expect(
      await screen.findByText("It's signed out the next time it's open and online, and stops syncing."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Everything it uploaded stays in your drive. Sign in on it again anytime to link it back."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Camera Uploads stops on it.")).not.toBeInTheDocument();
  });

  it("keeps the row and says so when the unlink fails", async () => {
    tauri.onInvoke("list_account_devices", () => ({ available: true, devices: [THIS, PHONE] }));
    tauri.onInvoke("unlink_account_device", () => {
      throw { kind: "Other", message: "Hippius couldn't finish that." };
    });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Unlink iPhone 15 Pro" }));
    fireEvent.click(await screen.findByRole("button", { name: /^unlink$/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Couldn\'t unlink "iPhone 15 Pro". Try again.'),
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText("iPhone 15 Pro")).toBeInTheDocument();
  });

  it("runs one unlink at a time", async () => {
    tauri.onInvoke("list_account_devices", () => ({ available: true, devices: [THIS, PHONE, LAPTOP] }));
    let finish: () => void = () => {};
    tauri.onInvoke("unlink_account_device", () => new Promise<null>((resolve) => (finish = () => resolve(null))));
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Unlink iPhone 15 Pro" }));
    fireEvent.click(await screen.findByRole("button", { name: /^unlink$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlink Work PC" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Unlink iPhone 15 Pro" })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlink Work PC" })).toBeEnabled());
  });
});
