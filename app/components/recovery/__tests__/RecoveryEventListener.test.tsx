// Mount-time self-heal probe of RecoveryEventListener (PR #124 review).
//
// Pinned behaviors:
//  - `unknown` is adopted for OAuth sessions ONLY. A mnemonic user with an
//    undecryptable local master booting offline also produces `unknown`
//    (decide_recovery_flow keeps that shape Unknown), but their recovery is
//    the seed phrase — no network needed — so the non-dismissable
//    connection-retry modal must not trap them (review P2-2).
//  - `unlock` stays auth-type-blind (genuinely actionable for both).
//  - The probe's async result never clobbers a dialog opened after mount
//    but before the probe resolved (review P3-1 stale-closure guard).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Provider, createStore } from "jotai";

import RecoveryEventListener from "../RecoveryEventListener";
import {
  activeRecoveryCheckAtom,
  type RecoveryCheck,
} from "@/app/lib/global-atoms/recoveryAtoms";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const authState = vi.hoisted(() => ({ authType: "oauth" as string | null }));
vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ authType: authState.authType }),
}));

const recoveryMocks = vi.hoisted(() => ({
  checkRecoveryState: vi.fn(),
  hasPendingRotation: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/app/lib/utils/recovery", () => recoveryMocks);

// The rotation dialog drags heavy deps and is out of scope here.
vi.mock("../FinishRotationDialog", () => ({
  default: () => null,
}));

function makeCheck(flow: RecoveryCheck["recommendedFlow"]): RecoveryCheck {
  return {
    hasServerBlob: flow === "unlock",
    hasLocalMnemonic: true,
    updatedAt: null,
    recommendedFlow: flow,
  };
}

function renderListener(preset: RecoveryCheck | null = null) {
  const store = createStore();
  if (preset) store.set(activeRecoveryCheckAtom, preset);
  render(
    <Provider store={store}>
      <RecoveryEventListener />
    </Provider>
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  recoveryMocks.hasPendingRotation.mockResolvedValue(false);
  authState.authType = "oauth";
});

describe("RecoveryEventListener mount-time self-heal", () => {
  it("oauth session: adopts an unknown probe result (retry dialog)", async () => {
    const check = makeCheck("unknown");
    recoveryMocks.checkRecoveryState.mockResolvedValue(check);
    const store = renderListener();

    await waitFor(() => expect(store.get(activeRecoveryCheckAtom)).toEqual(check));
  });

  it("mnemonic session: does NOT adopt unknown — the seed-phrase banner is their affordance", async () => {
    authState.authType = "mnemonic";
    recoveryMocks.checkRecoveryState.mockResolvedValue(makeCheck("unknown"));
    const store = renderListener();

    await waitFor(() => expect(recoveryMocks.checkRecoveryState).toHaveBeenCalled());
    // Give the async adoption path a tick to (wrongly) fire if it were going to.
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.get(activeRecoveryCheckAtom)).toBeNull();
  });

  it("mnemonic session: still adopts unlock (an unlock password set in settings is actionable)", async () => {
    authState.authType = "mnemonic";
    const check = makeCheck("unlock");
    recoveryMocks.checkRecoveryState.mockResolvedValue(check);
    const store = renderListener();

    await waitFor(() => expect(store.get(activeRecoveryCheckAtom)).toEqual(check));
  });

  it("never adopts proceed", async () => {
    recoveryMocks.checkRecoveryState.mockResolvedValue(makeCheck("proceed"));
    const store = renderListener();

    await waitFor(() => expect(recoveryMocks.checkRecoveryState).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.get(activeRecoveryCheckAtom)).toBeNull();
  });

  it("a slow probe never clobbers a dialog opened after mount", async () => {
    // The probe resolves late; meanwhile another writer (banner CTA, live
    // event) has populated the atom with a fresher check.
    let resolveProbe!: (c: RecoveryCheck) => void;
    recoveryMocks.checkRecoveryState.mockReturnValue(
      new Promise<RecoveryCheck>((r) => {
        resolveProbe = r;
      })
    );
    const store = renderListener();
    await waitFor(() => expect(recoveryMocks.checkRecoveryState).toHaveBeenCalled());

    const fresher = makeCheck("unlock");
    store.set(activeRecoveryCheckAtom, fresher);

    await act(async () => {
      resolveProbe(makeCheck("unknown"));
      await Promise.resolve();
    });

    expect(store.get(activeRecoveryCheckAtom)).toEqual(fresher);
  });
});
