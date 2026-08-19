"use client";

import React, { useState } from "react";
import { KeyRound } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { checkRecoveryState } from "@/app/lib/utils/recovery";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

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
  const setRecoveryCheck = useSetAtom(activeRecoveryCheckAtom);
  const { authType } = useWalletAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!needsReauth) return null;

  const isOAuth = authType === "oauth";

  const goToSeedPhraseForm = () => {
    // `?reauth=1` keeps the login page from bouncing an authenticated user
    // home, so the seed-phrase form is actually reachable (audit R-13).
    router.push("/login?reauth=1");
  };

  const handleReauth = async () => {
    if (!isOAuth) {
      goToSeedPhraseForm();
      return;
    }
    // OAuth: ask Rust which recovery flow applies right now. A blob on
    // the server → Unlock dialog; probe failure → retry dialog; only a
    // definitive "nothing to unlock" falls back to the seed phrase.
    setBusy(true);
    try {
      const check = await checkRecoveryState();
      if (check.recommendedFlow === "proceed") {
        goToSeedPhraseForm();
      } else {
        setRecoveryCheck(check);
      }
    } catch (err) {
      console.error("[SyncReauthRequiredAlert] recovery check failed:", err);
      toast.error(
        "Couldn't check your account's recovery state. Check your connection and try again."
      );
    } finally {
      setBusy(false);
    }
  };

  const title = isOAuth
    ? "Sync needs your unlock password"
    : "Sync needs your seed phrase";
  const body = isOAuth
    ? "Your session is still active, but this device can't unlock your files. Enter your unlock password to continue."
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
          "flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-50 border border-orange-200 text-orange-800",
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
        "flex items-start gap-3 p-3 rounded-lg bg-orange-50 border border-orange-200",
        className
      )}
      role="alert"
    >
      <div className="flex-shrink-0 mt-0.5">
        <KeyRound className="size-5 text-orange-600" />
      </div>
      <div className="flex-1">
        <p className="text-sm font-medium text-orange-800">{title}</p>
        <p className="text-xs mt-1 text-orange-700">{body}</p>
      </div>
      <button
        type="button"
        onClick={handleReauth}
        disabled={busy}
        className="flex-shrink-0 self-center px-3 py-1.5 text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-md disabled:opacity-60"
      >
        {cta}
      </button>
    </div>
  );
};

export default SyncReauthRequiredAlert;
