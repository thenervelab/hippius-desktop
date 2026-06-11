import { useAtom, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import {
  notificationsAtom,
  refreshNotificationsAtom,
  clearNotificationsAtom,
  markReadAtom,
  markUnreadAtom,
  markAllReadAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export function useNotifications() {
  const [notifications] = useAtom(notificationsAtom);
  const refresh = useSetAtom(refreshNotificationsAtom);
  const clearNotifications = useSetAtom(clearNotificationsAtom);
  const markRead = useSetAtom(markReadAtom);
  const markUnread = useSetAtom(markUnreadAtom);
  const markAllRead = useSetAtom(markAllReadAtom);

  const { polkadotAddress, oauthSession } = useWalletAuth();

  // `undefined` = no account observed yet (distinct from `null` = signed out).
  // Seeded on first run so the very first observation is NOT treated as a switch.
  const prevAddressRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const address = oauthSession?.substrateAddress || polkadotAddress || null;

    // Clear only on a genuine account *switch* (A → B, or signed-in → signed-out),
    // never on first observation. Each component that mounts this hook (the bell,
    // the notifications page) gets its own ref, so clearing on first mount would
    // blank the shared list every time the bell opens — flashing "Nothing here"
    // before the refresh below repopulates it. Rust enforces the real per-account
    // isolation; this is only a render-flicker guard.
    if (prevAddressRef.current !== undefined && address !== prevAddressRef.current) {
      clearNotifications();
    }
    prevAddressRef.current = address;

    // Always refresh — never gate on the frontend address. Rust scopes the read
    // to the signed-in session account and ignores any caller address, so a
    // momentarily-null frontend address (boot, or a restored mnemonic session
    // that exposes no `oauthSession`) must not suppress the fetch.
    refresh();
  }, [polkadotAddress, oauthSession, refresh, clearNotifications]);

  return { notifications, refresh, markRead, markUnread, markAllRead };
}
