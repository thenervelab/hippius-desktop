import { useAtom, useSetAtom } from "jotai";
import { useEffect } from "react";
import {
  notificationsAtom,
  refreshNotificationsAtom,
  markReadAtom,
  markUnreadAtom,
  markAllReadAtom,
  userAddressAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

export function useNotifications() {
  const [notifications] = useAtom(notificationsAtom);
  const refresh = useSetAtom(refreshNotificationsAtom);
  const markRead = useSetAtom(markReadAtom);
  const markUnread = useSetAtom(markUnreadAtom);
  const markAllRead = useSetAtom(markAllReadAtom);
  const setUserAddress = useSetAtom(userAddressAtom);

  const { polkadotAddress, oauthSession } = useWalletAuth();

  // Set the user address atom whenever it changes and refresh notifications
  useEffect(() => {
    const address = oauthSession?.substrateAddress || polkadotAddress;
    console.log("[useNotifications] Setting user address:", address);
    setUserAddress(address);

    // Refresh notifications after setting the address
    if (address) {
      refresh();
    }
  }, [polkadotAddress, oauthSession, setUserAddress, refresh]);

  return { notifications, refresh, markRead, markUnread, markAllRead };
}
