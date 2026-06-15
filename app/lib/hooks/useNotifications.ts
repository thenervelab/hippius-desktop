import { useAtom, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import {
  notificationsAtom,
  refreshNotificationsAtom,
  clearNotificationsAtom,
  markReadAtom,
  markUnreadAtom,
  markAllReadAtom,
  userAddressAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export function useNotifications() {
  const [notifications] = useAtom(notificationsAtom);
  const refresh = useSetAtom(refreshNotificationsAtom);
  const clearNotifications = useSetAtom(clearNotificationsAtom);
  const markRead = useSetAtom(markReadAtom);
  const markUnread = useSetAtom(markUnreadAtom);
  const markAllRead = useSetAtom(markAllReadAtom);
  const setUserAddress = useSetAtom(userAddressAtom);

  const { polkadotAddress, oauthSession } = useWalletAuth();

  // Track the previously-seen address so we only reset on a *real* account
  // change, not on every effect re-run (e.g. a new `oauthSession` object
  // identity with the same address).
  const prevAddressRef = useRef<string | null>(null);

  // Set the user address atom whenever it changes and refresh notifications
  useEffect(() => {
    const address = oauthSession?.substrateAddress || polkadotAddress;
    console.log("[useNotifications] Setting user address:", address);
    setUserAddress(address);

    // On a genuine account change (including logout → null), drop the previous
    // account's cached notifications synchronously so they cannot flash under
    // the new session while the async refresh below is in flight. Rust enforces
    // the actual per-account isolation; this is a render-flicker guard only.
    if (address !== prevAddressRef.current) {
      clearNotifications();
      prevAddressRef.current = address;
    }

    // Refresh notifications after setting the address
    if (address) {
      refresh();
    }
  }, [polkadotAddress, oauthSession, setUserAddress, refresh, clearNotifications]);

  return { notifications, refresh, markRead, markUnread, markAllRead };
}
