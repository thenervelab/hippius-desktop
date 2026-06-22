import { describe, it, expect, vi, beforeEach } from "vitest";

import { scheduleOAuthSyncInit } from "../scheduleOAuthSyncInit";
import { appStore } from "@/app/lib/store/jotaiStore";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";

describe("scheduleOAuthSyncInit", () => {
    beforeEach(() => {
        appStore.set(syncRequiresReauthAtom, false);
    });

    /**
     * Regression — fresh-device OAuth login with `flow=Unlock`.
     *
     * `complete_oauth_flow` flips the recovery gate to `Pending`,
     * so `ensure_sync_mnemonic` parks inside `await_recovery_resolved`
     * until the user submits the unlock dialog. The dialog is mounted
     * by `(pages)/layout.tsx`, which only renders after the callback
     * page navigates — which it can't do if `setOAuthSession` is
     * awaiting `ensure_sync_mnemonic`. The whole login deadlocks.
     *
     * This test simulates that deadlock by making the `ensure_sync_mnemonic`
     * invoke hang forever and asserting:
     *   1. `scheduleOAuthSyncInit` returns control immediately so the
     *      caller (setOAuthSession → OAuthCallbackPage) can proceed to
     *      navigation.
     *   2. `onReady` only fires after the IPC resolves — preserving
     *      the original ordering guarantee (initSync runs after the
     *      mnemonic is cached in AuthInfo).
     */
    it("does not block the caller while ensure_sync_mnemonic is parked on the recovery gate", async () => {
        let releaseInvoke: (() => void) | null = null;
        const invokeMock = vi.fn(() => new Promise<void>((res) => {
            releaseInvoke = res;
        }));

        const onReady = vi.fn();
        const pending = scheduleOAuthSyncInit("5TestAddress", onReady, invokeMock as never);

        // Give the microtask queue a turn so the inner async function
        // actually reaches the `await invokeFn(...)` point. If the
        // helper were awaiting inline, this await would also suspend
        // the test — instead the IIFE suspends, the promise is
        // returned, and control returns here.
        await Promise.resolve();
        await Promise.resolve();

        expect(invokeMock).toHaveBeenCalledWith("ensure_sync_mnemonic", { accountId: "5TestAddress" });
        // Critical assertion: `onReady` (the initSync trigger) has
        // NOT fired yet, and the returned promise has NOT resolved.
        // The caller — `setOAuthSession` — is free to return.
        expect(onReady).not.toHaveBeenCalled();

        // Simulate the user completing the recovery dialog: gate
        // resolves, the parked IPC returns, and the helper runs
        // `onReady` as the tail of its async block.
        releaseInvoke!();
        await pending;
        expect(onReady).toHaveBeenCalledWith("5TestAddress");
    });

    it("flips syncRequiresReauthAtom on MasterMnemonicUnrecoverable so the reauth banner shows", async () => {
        const invokeMock = vi.fn(() => Promise.reject({
            kind: "NotReady",
            subkind: "MASTER_MNEMONIC_UNRECOVERABLE",
            message: "Master mnemonic cannot be recovered",
        }));

        const onReady = vi.fn();
        await scheduleOAuthSyncInit("5TestAddress", onReady, invokeMock as never);

        expect(appStore.get(syncRequiresReauthAtom)).toBe(true);
        // `onReady` (→ initSync) must NOT fire on failure: latching sync as
        // initialized with no usable mnemonic wedges the engine. The reauth
        // banner takes over and the user re-enters the seed (audit R-25).
        expect(onReady).not.toHaveBeenCalled();
    });

    it("leaves the reauth atom untouched and does not latch sync on transient IPC errors", async () => {
        const invokeMock = vi.fn(() => Promise.reject(new Error("network unreachable")));

        const onReady = vi.fn();
        await scheduleOAuthSyncInit("5TestAddress", onReady, invokeMock as never);

        expect(appStore.get(syncRequiresReauthAtom)).toBe(false);
        // A transient failure must NOT latch sync as initialized — otherwise
        // the user lands in a silent half-initialized state with no banner and
        // no retry until the next auth cycle (audit R-25).
        expect(onReady).not.toHaveBeenCalled();
    });
});
