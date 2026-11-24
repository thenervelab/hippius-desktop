// Another device unlinked this computer. Rust's device check has already run
// the full logout and emits `this_device_unlinked`; the webview must clear its
// own half of the session WITHOUT calling `logout_full` a second time (which
// could only fail and toast "Logout failed" over a sign-out that worked), go
// to the sign-in screen, and say why there — once.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";

const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const resetSyncSession = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/store/resetSyncSession", () => ({ resetSyncSession }));
const clearLoginStatusCache = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/hooks/useTraySync", () => ({ useTrayInit: vi.fn(), clearLoginStatusCache }));
vi.mock("@/app/lib/hooks/useHcfsSync", () => ({ tryAutoInitSync: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/app/lib/hooks/useSyncEvents", () => ({ AUTH_RELOGIN_TOAST_ID: "auth-relogin" }));
vi.mock("@/app/lib/helpers/hippiusDesktopDB", () => ({ clearHippiusDesktopDB: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { WalletAuthProvider, useWalletAuth } from "@/app/lib/wallet-auth-context";
import { appStore } from "@/app/lib/store/jotaiStore";
import {
  DEVICE_UNLINKED_NOTICE_KEY,
  deviceUnlinkedNoticeAtom,
  forgetDeviceUnlinkedNotice,
} from "@/app/lib/global-atoms/deviceUnlinkedAtoms";
import DeviceUnlinkedNotice, {
  DEVICE_UNLINKED_BODY,
  DEVICE_UNLINKED_TITLE,
} from "@/app/components/auth/DeviceUnlinkedNotice";
import { THIS_DEVICE_UNLINKED_EVENT } from "@/app/lib/tauri/devices";

const ACCOUNT = "5SignedInAccount";

function Probe() {
  const { isAuthenticated, polkadotAddress } = useWalletAuth();
  return <div data-testid="session">{`${isAuthenticated}:${polkadotAddress ?? ""}`}</div>;
}

function renderSignedIn() {
  tauri.onInvoke("restore_session", () => ({
    authenticated: true,
    substrateAddress: ACCOUNT,
    authType: "mnemonic",
    oauthSession: null,
    logoutTimeMs: null,
    shouldClearOauth: false,
    needsSyncMnemonic: false,
    redirectTo: null,
    syncRequiresReauth: false,
  }));
  tauri.onInvoke("stop_sync", () => null);
  return render(
    <Provider store={appStore}>
      <WalletAuthProvider>
        <Probe />
      </WalletAuthProvider>
    </Provider>,
  );
}

async function listening() {
  await waitFor(() =>
    expect(tauri.event.listen.mock.calls.some(([name]) => name === THIS_DEVICE_UNLINKED_EVENT)).toBe(true),
  );
}

function logoutFullCalls() {
  return tauri.core.invoke.mock.calls.filter(([command]) => command === "logout_full");
}

beforeEach(() => {
  tauri.reset();
  router.push.mockReset();
  resetSyncSession.mockReset();
  clearLoginStatusCache.mockReset();
  toast.error.mockReset();
  forgetDeviceUnlinkedNotice();
  window.localStorage.clear();
});

describe("this computer unlinked from another device", () => {
  it("clears the webview's session and goes to sign in, without a second logout_full", async () => {
    window.localStorage.setItem("hippius_oauth_provider", "google");
    renderSignedIn();
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(`true:${ACCOUNT}`));
    await listening();

    await act(() => tauri.emitEvent(THIS_DEVICE_UNLINKED_EVENT, { accountId: ACCOUNT }));

    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent("false:"));
    expect(router.push).toHaveBeenCalledWith("/login");
    expect(resetSyncSession).toHaveBeenCalled();
    expect(clearLoginStatusCache).toHaveBeenCalled();
    expect(window.localStorage.getItem("hippius_oauth_provider")).toBeNull();
    expect(logoutFullCalls()).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();
    // The sign-in screen will say why, now and after a reload.
    expect(appStore.get(deviceUnlinkedNoticeAtom)).toBe(true);
    expect(window.localStorage.getItem(DEVICE_UNLINKED_NOTICE_KEY)).toBe("1");
  });

  it("ignores the event for an account that is not the one signed in here", async () => {
    renderSignedIn();
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(`true:${ACCOUNT}`));
    await listening();

    await act(() => tauri.emitEvent(THIS_DEVICE_UNLINKED_EVENT, { accountId: "5SomeoneElse" }));

    expect(screen.getByTestId("session")).toHaveTextContent(`true:${ACCOUNT}`);
    expect(router.push).not.toHaveBeenCalled();
    expect(appStore.get(deviceUnlinkedNoticeAtom)).toBe(false);
    expect(window.localStorage.getItem(DEVICE_UNLINKED_NOTICE_KEY)).toBeNull();
  });

  it("still signs out through logout_full when the person signs out themselves", async () => {
    tauri.onInvoke("logout_full", () => null);
    let signOut: (path?: string) => Promise<void> = async () => {};
    function SignOutProbe() {
      signOut = useWalletAuth().logout;
      return null;
    }
    tauri.onInvoke("restore_session", () => ({
      authenticated: true,
      substrateAddress: ACCOUNT,
      authType: "mnemonic",
      oauthSession: null,
      logoutTimeMs: null,
      shouldClearOauth: false,
      needsSyncMnemonic: false,
      redirectTo: null,
      syncRequiresReauth: false,
    }));
    tauri.onInvoke("stop_sync", () => null);
    render(
      <Provider store={appStore}>
        <WalletAuthProvider>
          <Probe />
          <SignOutProbe />
        </WalletAuthProvider>
      </Provider>,
    );
    await waitFor(() => expect(screen.getByTestId("session")).toHaveTextContent(`true:${ACCOUNT}`));

    await act(() => signOut("/login"));

    expect(logoutFullCalls()).toEqual([["logout_full", { accountId: ACCOUNT }]]);
    expect(screen.getByTestId("session")).toHaveTextContent("false:");
    expect(router.push).toHaveBeenCalledWith("/login");
    // Signing out yourself is not being unlinked.
    expect(appStore.get(deviceUnlinkedNoticeAtom)).toBe(false);
  });
});

describe("the sign-in screen's notice", () => {
  function renderNotice() {
    return render(
      <Provider store={appStore}>
        <DeviceUnlinkedNotice />
      </Provider>,
    );
  }

  it("says nothing when no unlink happened", () => {
    renderNotice();
    expect(screen.queryByText(DEVICE_UNLINKED_TITLE)).not.toBeInTheDocument();
  });

  it("shows once after the unlink and is gone after OK", async () => {
    act(() => {
      appStore.set(deviceUnlinkedNoticeAtom, true);
      window.localStorage.setItem(DEVICE_UNLINKED_NOTICE_KEY, "1");
    });
    renderNotice();
    expect(await screen.findByText(DEVICE_UNLINKED_TITLE)).toBeInTheDocument();
    expect(screen.getByText(DEVICE_UNLINKED_BODY)).toBeInTheDocument();
    expect(DEVICE_UNLINKED_BODY).toBe(
      "It was removed from your account on another device. Sign in again to link it back. Everything it uploaded stays in your drive.",
    );

    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(screen.queryByText(DEVICE_UNLINKED_TITLE)).not.toBeInTheDocument());
    expect(appStore.get(deviceUnlinkedNoticeAtom)).toBe(false);
    expect(window.localStorage.getItem(DEVICE_UNLINKED_NOTICE_KEY)).toBeNull();
  });

  it("still shows after a reload, from what was stored", async () => {
    window.localStorage.setItem(DEVICE_UNLINKED_NOTICE_KEY, "1");
    renderNotice();
    expect(await screen.findByText(DEVICE_UNLINKED_TITLE)).toBeInTheDocument();
  });
});
