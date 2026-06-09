import { invoke } from "@tauri-apps/api/core";

import { appStore } from "@/app/lib/store/jotaiStore";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { isMasterMnemonicUnrecoverable } from "@/app/lib/utils/dispatchTauriError";

type InvokeFn = typeof invoke;

/**
 * Run the post-OAuth sync prelude in the background.
 *
 * `ensure_sync_mnemonic` parks on the Rust-side recovery gate when
 * `complete_oauth_flow` flipped it to `Pending` (fresh-device Unlock
 * flow). Awaiting that call from the OAuth callback page deadlocks
 * login: the callback never navigates, so the `(pages)` layout never
 * mounts, so `AccountRecoveryDialog` never renders, so the user can
 * never unlock — and the gate can never resolve. Kicking it off here
 * detached from the caller's await chain lets navigation proceed
 * immediately; the backgrounded IPC unblocks once the dialog finishes
 * recovery and then the `onReady` callback fires `initSync`.
 *
 * Returned promise is mainly useful for tests — production callers
 * `void`-discard it.
 */
export function scheduleOAuthSyncInit(
    accountId: string,
    onReady: (id: string) => void,
    invokeFn: InvokeFn = invoke,
): Promise<void> {
    return (async () => {
        try {
            await invokeFn("ensure_sync_mnemonic", { accountId });
        } catch (err) {
            console.error("[WalletAuth] ensure_sync_mnemonic failed:", err);
            // Surface the reauth banner when Rust refuses to mint a
            // fresh mnemonic because encrypted state already exists —
            // without the banner, `initSync` dies with an opaque
            // `Crypto: decryption failed` a few ticks later.
            if (isMasterMnemonicUnrecoverable(err)) {
                appStore.set(syncRequiresReauthAtom, true);
            }
            // Do NOT call onReady on failure. `onReady` is `initSync`, which
            // latches `syncInitialized=true` and runs `tryAutoInitSync`; doing
            // that with no usable mnemonic in AuthInfo wedges the sync engine
            // and suppresses re-init until the next full auth cycle — silently,
            // with no banner on a transient failure (audit R-25). The reauth
            // banner (unrecoverable) or the next auth cycle (transient) is what
            // drives the retry.
            return;
        }
        onReady(accountId);
    })();
}
