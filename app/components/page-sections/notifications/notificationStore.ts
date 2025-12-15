/* eslint-disable @typescript-eslint/no-explicit-any */
import { atom } from "jotai";
import {
  listNotifications,
  markRead,
  markUnread,
  markAllRead,
  getEnabledNotificationTypes,
} from "@/app/lib/helpers/notificationsDb";
import { UiNotification } from "@/components/page-sections/notifications/types";
import { Icons } from "@/components/ui";
import { iconMap } from "@/lib/helpers/notificationIcons";
import { unreadCount } from "@/lib/helpers/notificationsDb";

// Add debug helpers to window for testing
if (typeof window !== 'undefined') {
  (window as any).__clearNotifications = async () => {
    const { clearAllNotifications } = await import('@/app/lib/helpers/notificationsDb');
    await clearAllNotifications();
    console.log('✅ All notifications cleared from database!');
  };

  (window as any).__debugNotifications = async (userAddress?: string) => {
    const { default: initSqlJs } = await import('sql.js/dist/sql-wasm.js');
    const { initHippiusDesktopDB } = await import('@/app/lib/helpers/hippiusDesktopDB');

    const db = await initHippiusDesktopDB();
    const query = userAddress
      ? `SELECT * FROM notifications WHERE userAddress = ?`
      : `SELECT * FROM notifications`;
    const params = userAddress ? [userAddress] : [];

    const result = db.exec(query, params);

    console.log("=== NOTIFICATIONS DEBUG ===");
    console.log(`Filter: ${userAddress || "ALL USERS"}`);
    console.log(`Total notifications: ${result[0]?.values.length || 0}`);

    if (result[0]?.values.length) {
      const columns = result[0].columns;
      result[0].values.forEach((row, idx) => {
        const obj: any = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
        });
        console.log(`[${idx}]`, obj);
      });
    }
    console.log("======================");
  };
}

export const notificationsAtom = atom<UiNotification[]>([]);

// Atom to store the current user address for notifications
export const userAddressAtom = atom<string | null>(null);

// Atom to store enabled notification types
export const enabledNotificationTypesAtom = atom<string[]>([]);

// Atom to refresh the enabled notification types
export const refreshEnabledTypesAtom = atom(null, async (_, set) => {
  const types = await getEnabledNotificationTypes();
  set(enabledNotificationTypesAtom, types);
});

// helper atom → fetch + update list in one call
export const refreshNotificationsAtom = atom(null, async (get, set) => {
  // Get the current user address
  const userAddress = get(userAddressAtom);
  if (!userAddress) {
    console.warn("[NotificationStore] No user address, skipping notification refresh");
    set(notificationsAtom, []);
    set(unreadCountAtom, 0);
    return;
  }

  // First get the enabled types so we can filter by them
  const enabledTypes = get(enabledNotificationTypesAtom);

  // Fetch all notifications for this user
  const rows = await listNotifications(userAddress, 100);

  const mapped = rows.map((r: any[]) => {
    // Column indices with userAddress:
    // 0: id, 1: userAddress, 2: notificationType, 3: notificationSubtype, 
    // 4: notificationTitleText, 5: notificationDescription, 6: notificationLinkText,
    // 7: notificationLink, 8: isUnread, 9: notificationCreationTime, 10: isDeleted, 11: deletedAt
    const timestamp = Number(r[9]);

    return {
      id: Number(r[0]),
      icon: iconMap[r[2]] ?? Icons.Document,
      type: r[2],
      subType: r[3] || "",
      title: r[4],
      description: r[5],
      buttonText: r[6],
      buttonLink: r[7],
      unread: r[8] === 1,
      // Keep original timestamp for TimeAgo component
      timestamp: timestamp,
      // Fallback time display in case TimeAgo fails
      time: isNaN(timestamp)
        ? "Unknown date"
        : new Date(timestamp).toLocaleString(),
    };
  });

  const filteredNotifications =
    enabledTypes.length > 0
      ? mapped.filter(
        (notification) =>
          enabledTypes.includes(notification.type) ||
          notification.type === "Hippius"
      )
      : mapped;

  set(notificationsAtom, filteredNotifications);

  // Update unread count based on filtered notifications
  const unreadCount = filteredNotifications.filter(n => n.unread).length;
  set(unreadCountAtom, unreadCount);
});

// write-only atoms for actions
export const markReadAtom = atom(null, async (get, set, id: number) => {
  await markRead(id);
  set(
    notificationsAtom,
    get(notificationsAtom).map((n) =>
      n.id === id ? { ...n, unread: false } : n
    )
  );
});

export const markUnreadAtom = atom(null, async (get, set, id: number) => {
  await markUnread(id);
  set(
    notificationsAtom,
    get(notificationsAtom).map((n) =>
      n.id === id ? { ...n, unread: true } : n
    )
  );
});

export const markAllReadAtom = atom(null, async (get, set) => {
  const userAddress = get(userAddressAtom);
  if (!userAddress) return;

  await markAllRead(userAddress);
  set(
    notificationsAtom,
    get(notificationsAtom).map((n) => ({ ...n, unread: false }))
  );
  set(unreadCountAtom, 0);
});

// Jotai atom for unread count
export const unreadCountAtom = atom<number>(0);

// Function to refresh unread count and update atom
// This triggers a full notification refresh which will update both notifications and count
export const refreshUnreadCountAtom = atom(null, async (get, set) => {
  await set(refreshNotificationsAtom);
});
