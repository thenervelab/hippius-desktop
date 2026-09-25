"use client";

import React, { useCallback, useEffect } from "react";
import { KeyRound } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { cn } from "@/lib/utils";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { checkRecoveryState } from "@/app/lib/utils/recovery";
import { useUnlockFlow } from "@/app/lib/hooks/useUnlockFlow";

interface SyncReauthRequiredAlertProps {
  className?: string;
  variant?: "banner" | "compact";
}

/**
 * Alert shown when sync can't recover the encryption mnemonic on this
 * device — `AuthInfo.mnemonic` is `None` and the sync engine is wedged
 * behind the encrypted `drive_password` chicken-and-egg lock.
 *
 * The recovery affordance depends on how the user signs in, so the
 * banner branches on `authType` (presentation only — Rust owns the
 * recovery decision):
 *
 * - **Mnemonic users** re-enter their seed phrase via the normal
 *   login flow, so the CTA routes to `/login?reauth=1`.
 * - **OAuth users** typically never saw a seed phrase — their path is
 *   the recovery ("unlock") password. The CTA re-runs Rust's
 *   `check_recovery_state` and adopts any non-`proceed` flow into
 *   `activeRecoveryCheckAtom`, which mounts `AccountRecoveryDialog`
 *   (Unlock / retry / signup — Rust decides which). Only when Rust
 *   answers `proceed` (server definitively has no blob to unlock) does
 *   it fall back to the seed-phrase form, the last remaining path.
 *
 * Mirrors the deleted `SyncStoppedAlert` component (commit
 * `6f467abe`) — same visual language, same two-variant layout, same
 * mount point in the DriveContainer alerts stack — but with a
 * different trigger (the `syncRequiresReauthAtom`) and a dedicated
 * call-to-action button.
 *
 * The atom is set from `result.syncRequiresReauth` on session
 * restore or when `ensure_sync_mnemonic` fails with
 * `MasterMnemonicUnrecoverable`, and cleared to `false` after a
 * successful `login_with_mnemonic`, so the banner vanishes as soon as
 * the user completes the re-entry flow.
 *
 * Returns `null` when no reauth is required — safe to mount
 * unconditionally anywhere a sync-related alert would live.
 */
export const SyncReauthRequiredAlert: React.FC<SyncReauthRequiredAlertProps> = ({
  className,
  variant = "banner",
}) => {
  const needsReauth = useAtomValue(syncRequiresReauthAtom);
  const setNeedsReauth = useSetAtom(syncRequiresReauthAtom);
  const { unlock, busy, isOAuth } = useUnlockFlow();

  // Self-dismiss a stale banner.
  //
  // `syncRequiresReauthAtom` is cleared after a successful
  // `login_with_mnemonic` -- which an OAuth user never performs, so once the
  // flag was raised it could not come down, and the banner outlived the
  // condition it described. It is raised during session restore, before the
  // keychain has rehydrated the mnemonic, so it is routinely raised on a
  // device that turns out to be perfectly healthy. Re-ask Rust on mount and
  // stand down when it says local is authoritative.
  const verifyStillNeeded = useCallback(async () => {
    try {
      const check = await checkRecoveryState();
      if (check.recommendedFlow === "proceed" && check.canDecryptLocal) {
        setNeedsReauth(false);
      }
    } catch {
      // Leave the banner up: an unreachable server is not evidence that the
      // device is fine, and the button re-checks anyway.
    }
  }, [setNeedsReauth]);

  useEffect(() => {
    if (needsReauth && isOAuth) void verifyStillNeeded();
  }, [needsReauth, isOAuth, verifyStillNeeded]);

  if (!needsReauth) return null;

  const handleReauth = () => void unlock();

  const title = isOAuth
    ? "Sync needs your unlock password"
    : "Sync needs your seed phrase";
  const body = isOAuth
    ? "Your session is still active, but this device can't unlock your files. Enter your unlock password, or your mnemonic seed if you forgot the password."
    : "Your session is still active, but your seed phrase isn't cached on this device, so sync can't unlock your files. Re-enter it to continue.";
  const cta = isOAuth ? "Enter unlock password" : "Re-enter seed phrase";
  const compactText = isOAuth
    ? "Sync needs your unlock password to continue."
    : "Sync needs your seed phrase to continue.";
  const compactCta = isOAuth ? "Unlock" : "Re-enter";

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-lg border",
          "bg-orange-50 border-orange-200 text-orange-800",
          "dark:bg-orange-500/10 dark:border-orange-500/30 dark:text-orange-200",
          className
        )}
        role="alert"
      >
        <KeyRound className="size-4 flex-shrink-0" />
        <span className="text-sm font-medium flex-1">{compactText}</span>
        <button
          type="button"
          onClick={handleReauth}
          disabled={busy}
          className="flex-shrink-0 text-sm font-semibold underline hover:no-underline disabled:opacity-60"
        >
          {compactCta}
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-3 p-3 rounded-lg border",
        "bg-orange-50 border-orange-200",
        "dark:bg-orange-500/10 dark:border-orange-500/30",
        className
      )}
      role="alert"
    >
      <div className="flex-shrink-0 mt-0.5">
        <KeyRound className="size-5 text-orange-600 dark:text-orange-300" />
      </div>
      <div className="flex-1">
        <p className="text-sm font-medium text-orange-800 dark:text-orange-100">{title}</p>
        <p className="text-xs mt-1 text-orange-700 dark:text-orange-200/80">{body}</p>
      </div>
      <button
        type="button"
        onClick={handleReauth}
        disabled={busy}
        className="flex-shrink-0 self-center px-3 py-1.5 text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 dark:bg-orange-500 dark:hover:bg-orange-400 dark:text-black-500 rounded-md disabled:opacity-60"
      >
        {cta}
      </button>
    </div>
  );
};

export default SyncReauthRequiredAlert;
