import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import React from "react";

// H-016: a recovered balance returns shouldNotify=false after Rust marks
// existing LowCreditWarning rows read. The badge only drops if this hook
// still calls refreshUnread on that path.
const h = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return {
    tauri: makeTauriMock(),
    refreshUnread: vi.fn(),
    addNotification: vi.fn(),
    state: {
      polkadotAddress: "5poll" as string | null,
      oauthSession: null as { substrateAddress?: string } | null,
    },
  };
});
vi.mock("@tauri-apps/api/core", () => h.tauri.core);
vi.mock("@/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({
    polkadotAddress: h.state.polkadotAddress,
    oauthSession: h.state.oauthSession,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/files",
}));
vi.mock("@/app/lib/hooks/api/useAddCreditEvent", () => ({
  default: () => ({ data: [], isSuccess: false }),
}));
vi.mock("@/app/lib/helpers/notificationsDb", () => ({
  addNotification: (...args: unknown[]) => h.addNotification(...args),
}));
vi.mock("@/components/page-sections/notifications/notificationStore", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/components/page-sections/notifications/notificationStore")
    >();
  const { atom } = await import("jotai");
  return {
    ...actual,
    refreshUnreadCountAtom: atom(null, () => {
      h.refreshUnread();
    }),
    refreshEnabledTypesAtom: atom(null, () => {}),
  };
});

const { tauri, state, refreshUnread, addNotification } = h;

import { useCreditsNotification } from "@/lib/hooks/useCreditsNotification";
import { enabledNotificationTypesAtom } from "@/components/page-sections/notifications/notificationStore";

function mount() {
  const store = createStore();
  store.set(enabledNotificationTypesAtom, ["Credits"]);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return renderHook(() => useCreditsNotification(), { wrapper });
}

beforeEach(() => {
  tauri.reset();
  refreshUnread.mockClear();
  addNotification.mockClear();
  addNotification.mockResolvedValue(undefined);
  state.polkadotAddress = "5poll";
  state.oauthSession = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useCreditsNotification — low-credit check", () => {
  it("refreshes the unread badge when shouldNotify is false (H-016 top-up)", async () => {
    tauri.onInvoke("check_low_credit_notification_live", () => ({
      shouldNotify: false,
      creditBalance: 0,
    }));

    mount();

    await waitFor(() => {
      expect(refreshUnread).toHaveBeenCalled();
    });
    expect(addNotification).not.toHaveBeenCalled();
  });

  it("creates a warning and refreshes the unread badge when shouldNotify is true", async () => {
    tauri.onInvoke("check_low_credit_notification_live", () => ({
      shouldNotify: true,
      creditBalance: 0.12,
    }));

    mount();

    await waitFor(() => {
      expect(addNotification).toHaveBeenCalled();
      expect(refreshUnread).toHaveBeenCalled();
    });
  });
});
