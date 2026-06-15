"use client";

import React from "react";
import { KeyRound } from "lucide-react";
import { useAtomValue } from "jotai";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";

interface SyncReauthRequiredAlertProps {
  className?: string;
  variant?: "banner" | "compact";
}

/**
 * Alert shown when Rust's `restore_session` successfully rehydrated
 * the session but the OS keychain didn't have the user's mnemonic —
 * leaving `AuthInfo.mnemonic = None` and the sync engine wedged
 * behind the encrypted `drive_password` chicken-and-egg lock. The
 * only recovery path is for the user to re-enter their seed phrase
 * via the normal mnemonic-login flow, so this banner routes them
 * straight to `/login`.
 *
 * Mirrors the deleted `SyncStoppedAlert` component (commit
 * `6f467abe`) — same visual language, same two-variant layout, same
 * mount point in the DriveContainer alerts stack — but with a
 * different trigger (the new `syncRequiresReauthAtom`) and a
 * dedicated call-to-action button.
 *
 * The atom is set from `result.syncRequiresReauth` on session
 * restore and cleared to `false` after a successful
 * `login_with_mnemonic`, so the banner vanishes as soon as the user
 * completes the re-entry flow.
 *
 * Returns `null` when no reauth is required — safe to mount
 * unconditionally anywhere a sync-related alert would live.
 */
export const SyncReauthRequiredAlert: React.FC<SyncReauthRequiredAlertProps> = ({
  className,
  variant = "banner",
}) => {
  const needsReauth = useAtomValue(syncRequiresReauthAtom);
  const router = useRouter();

  if (!needsReauth) return null;

  const handleReauth = () => {
    router.push("/login");
  };

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
        <span className="text-sm font-medium flex-1">
          Sync needs your seed phrase to continue.
        </span>
        <button
          type="button"
          onClick={handleReauth}
          className="flex-shrink-0 text-sm font-semibold underline hover:no-underline"
        >
          Re-enter
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
        <p className="text-sm font-medium text-orange-800">
          Sync needs your seed phrase
        </p>
        <p className="text-xs mt-1 text-orange-700">
          Your session is still active, but your seed phrase isn&apos;t
          cached on this device, so sync can&apos;t unlock your files.
          Re-enter it to continue.
        </p>
      </div>
      <button
        type="button"
        onClick={handleReauth}
        className="flex-shrink-0 self-center px-3 py-1.5 text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-md"
      >
        Re-enter seed phrase
      </button>
    </div>
  );
};

export default SyncReauthRequiredAlert;
