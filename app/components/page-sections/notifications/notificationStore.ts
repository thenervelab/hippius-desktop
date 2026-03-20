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
import { invoke } from "@tauri-apps/api/core";

// Add debug helpers to window for testing
if (typeof window !== 'undefined') {
  (window as any).__clearNotifications = async () => {
    const { clearAllNotifications } = await import('@/app/lib/helpers/notificationsDb');
    await clearAllNotifications();
    console.log('All notifications cleared from database!');
  };

  (window as any).__debugNotifications = async (userAddress?: string) => {
    try {
      const notifications = await invoke<any[]>("list_notifications", {
        userAddress: userAddress || "system",
        limit: 1000,
      });
      console.log("=== NOTIFICATIONS DEBUG ===");
      console.log(`Filter: ${userAddress || "ALL USERS"}`);
      console.log(`Total notifications: ${notifications.length}`);
      notifications.forEach((n: any, idx: number) => {
        console.log(`[${idx}]`, n);
      });
      console.log("======================");
    } catch (error) {
      console.error("Failed to debug notifications:", error);
    }
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

// helper atom — fetch + update list in one call
export const refreshNotificationsAtom = atom(null, async (get, set) => {
  // Get the current user address
  const userAddress = get(userAddressAtom);
  if (!userAddress) {
    console.warn("[NotificationStore] No user address, skipping notification refresh");
    set(notificationsAtom, []);
    set(unreadCountAtom, 0);
    return;
  }

  // Always fetch enabled types fresh from the backend so we never rely
  // on a stale atom value (the atom may still be at its default `[]`).
  const enabledTypes = await getEnabledNotificationTypes();
  set(enabledNotificationTypesAtom, enabledTypes);

  // Fetch all notifications for this user (Rust returns objects, not raw rows)
  const rows = await listNotifications(userAddress, 100);

  const mapped = rows.map((r: any) => {
    const timestamp = Number(r.creationTime);
    const releaseNotes = typeof r.releaseNotes === "string" ? r.releaseNotes : "";

    return {
      id: Number(r.id),
      icon: iconMap[r.notificationType] ?? Icons.Document,
      type: r.notificationType,
      subType: r.notificationSubtype || "",
      title: r.titleText,
      description: r.description,
      buttonText: r.linkText,
      buttonLink: r.link,
      releaseNotes,
      unread: r.isUnread === true || r.isUnread === 1,
      // Keep original timestamp for TimeAgo component
      timestamp: timestamp,
      // Fallback time display in case TimeAgo fails
      time: isNaN(timestamp)
        ? "Unknown date"
        : new Date(timestamp).toLocaleString(),
    };
  });

  // Filter: only show notifications whose type is enabled, plus Hippius system
  // notifications which are always visible.
  const filteredNotifications = mapped.filter(
    (notification) =>
      enabledTypes.includes(notification.type) ||
      notification.type === "Hippius"
  );

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
