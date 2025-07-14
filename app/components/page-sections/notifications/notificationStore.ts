/* eslint-disable @typescript-eslint/no-explicit-any */
import { atom } from "jotai";
import {
  listNotifications,
  markRead,
  markUnread,
  markAllRead,
  getEnabledNotificationTypes,
} from "@/app/lib/helpers/notificationsDb";
import { UiNotification } from "../../page-sections/notifications/types";
import { Icons } from "../../ui";
import { iconMap } from ".";
import { unreadCount } from "@/lib/helpers/notificationsDb";

export const notificationsAtom = atom<UiNotification[]>([]);

// Atom to store enabled notification types
export const enabledNotificationTypesAtom = atom<string[]>([]);

// Atom to refresh the enabled notification types
export const refreshEnabledTypesAtom = atom(null, async (_, set) => {
  const types = await getEnabledNotificationTypes();
  set(enabledNotificationTypesAtom, types);
});

// helper atom → fetch + update list in one call
export const refreshNotificationsAtom = atom(null, async (get, set) => {
  // First get the enabled types so we can filter by them
  const enabledTypes = get(enabledNotificationTypesAtom);

  // Fetch all notifications
  const rows = await listNotifications(100);

  const mapped = rows.map((r: any[]) => {
    // Extract the timestamp (stored as milliseconds since epoch)
    const timestamp = Number(r[8]);

    return {
      id: Number(r[0]),
      icon: iconMap[r[1]] ?? Icons.Document,
      type: r[1],
      subType: r[2] || "",
      title: r[3],
      description: r[4],
      buttonText: r[5],
      buttonLink: r[6],
      unread: r[7] === 1,
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

  // Make sure to call the refresh function properly
  set(refreshEnabledTypesAtom);
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
  await markAllRead();
  set(
    notificationsAtom,
    get(notificationsAtom).map((n) => ({ ...n, unread: false }))
  );
});

// Jotai atom for unread count
export const unreadCountAtom = atom<number>(0);

// Function to refresh unread count and update atom
export const refreshUnreadCountAtom = atom(null, async (get, set) => {
  const count = await unreadCount();
  set(unreadCountAtom, count);
});
