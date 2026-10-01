import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EMPTY_SNAPSHOT } from "@/app/lib/types/syncSnapshot";
import type { TrayMenuData } from "@/app/lib/tray/useTrayPanelData";

// The popover's header balance and footer account chip, rendered from what
// `get_tray_menu_data` returns. The data hook is stubbed so each test seeds
// the menu payload directly; everything else the page invokes is inert.

const ADDRESS = "5CPQ46eGx7nRkTyY2pV9wH3aLmZcQ1uS8bDfJ4kN6tWqFdJ";

let menu: TrayMenuData | null = null;

vi.mock("@/app/lib/tray/useTrayPanelData", () => ({
  useTrayPanelData: () => ({
    menu,
    feed: [],
    snapshot: EMPTY_SNAPSHOT,
    blockNumber: 7792047,
    isConnected: true,
    unreadCount: 0,
    chatUnread: 0,
    loading: false,
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  Window: { getByLabel: vi.fn(() => Promise.resolve(null)) },
}));
// The identicon is a client-only dynamic import; it says nothing here.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import TrayPanelPage from "../page";

function seed(overrides: Partial<TrayMenuData>) {
  menu = {
    loggedIn: true,
    credits: 0.36,
    balance: "0.36",
    accountLabel: null,
    substrateAddress: ADDRESS,
    sessionReady: true,
    ...overrides,
  };
}

describe("tray popover header balance", () => {
  beforeEach(() => seed({}));

  it("reads as a dollar balance, not a credit count", () => {
    render(<TrayPanelPage />);
    expect(screen.getByText("Balance")).toBeInTheDocument();
    expect(screen.queryByText(/credits/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("tray-balance")).toHaveTextContent("$0.36");
  });

  it("uses a '.' decimal whatever the locale, like the file sizes", () => {
    // `toLocaleString` gave "0,36" on a French machine.
    const spy = vi
      .spyOn(Number.prototype, "toLocaleString")
      .mockImplementation(function (this: number) {
        return String(this).replace(".", ",");
      });
    try {
      seed({ balance: "1660.6" });
      render(<TrayPanelPage />);
      expect(screen.getByTestId("tray-balance")).toHaveTextContent("$1,660.60");
    } finally {
      spy.mockRestore();
    }
  });

  it("shows a dash, not $0.00, while the balance is unknown", () => {
    seed({ balance: null, credits: null });
    render(<TrayPanelPage />);
    expect(screen.getByTestId("tray-balance")).toHaveTextContent("—");
  });
});

describe("tray popover account chip", () => {
  it("leads an OAuth account with its email, the SS58 underneath, no block", () => {
    seed({ accountLabel: "ahmad@example.com" });
    render(<TrayPanelPage />);
    expect(screen.getByTitle("ahmad@example.com")).toBeInTheDocument();
    expect(screen.getByTitle(ADDRESS)).toBeInTheDocument();
    expect(screen.queryByText(/7792047/)).not.toBeInTheDocument();
  });

  it("keeps the address and live block for an access-key account", () => {
    seed({ accountLabel: null });
    render(<TrayPanelPage />);
    expect(screen.getByText("5CPQ46…qFdJ")).toBeInTheDocument();
    expect(screen.getByText(/7792047/)).toBeInTheDocument();
  });
});
