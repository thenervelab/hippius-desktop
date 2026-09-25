"use client";

// The one way into "unlock this device": the recovery (unlock) password for an
// account that signs in with a provider, the seed phrase for one that signs in
// with it. Shared by the sync banner and the Manage access panel's locked
// links, so both open the same flow. Rust decides which recovery flow applies
// (`check_recovery_state`); this only routes to it.

import { useCallback, useState } from "react";
import { useSetAtom } from "jotai";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { activeRecoveryCheckAtom } from "@/app/lib/global-atoms/recoveryAtoms";
import { checkRecoveryState } from "@/app/lib/utils/recovery";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export function useUnlockFlow(): { unlock: () => Promise<void>; busy: boolean; isOAuth: boolean } {
  const setNeedsReauth = useSetAtom(syncRequiresReauthAtom);
  const setRecoveryCheck = useSetAtom(activeRecoveryCheckAtom);
  const { authType } = useWalletAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const isOAuth = authType === "oauth";

  const unlock = useCallback(async () => {
    // `?reauth=1` keeps the login page from bouncing an authenticated user
    // home, so the seed-phrase form is actually reachable (audit R-13).
    const goToSeedPhraseForm = () => router.push("/login?reauth=1");
    if (!isOAuth) {
      goToSeedPhraseForm();
      return;
    }
    // OAuth: ask Rust which recovery flow applies right now. A blob on
    // the server → Unlock dialog; probe failure → retry dialog. `proceed`
    // splits: healthy means the banner is simply stale, and only an
    // unopenable local mnemonic falls back to the seed phrase.
    setBusy(true);
    try {
      const check = await checkRecoveryState();
      if (check.recommendedFlow !== "proceed") {
        setRecoveryCheck(check);
      } else if (check.canDecryptLocal) {
        // Nothing to unlock and nothing wrong: Rust says local is
        // authoritative. Sending the user to the sign-in screen here read as
        // being logged out for no reason.
        setNeedsReauth(false);
        toast.success("Sync is unlocked on this device.");
      } else {
        // Unopenable local mnemonic with nothing on the server to unlock:
        // the seed phrase is the only remaining way back in.
        goToSeedPhraseForm();
      }
    } catch (err) {
      console.error("[useUnlockFlow] recovery check failed:", err);
      toast.error("Couldn't check your account's recovery state. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }, [isOAuth, router, setNeedsReauth, setRecoveryCheck]);

  return { unlock, busy, isOAuth };
}
