import { atom } from "jotai";
import {
  listNotifications,
  markRead,
  markUnread,
  markAllRead,
  getEnabledNotificationTypes,
} from "@/app/lib/helpers/notificationsDb";
import type { NotificationRow } from "@/app/lib/helpers/notificationsDb";
import { UiNotification } from "@/components/page-sections/notifications/types";
import { Icons } from "@/components/ui";
import { iconMap } from "@/lib/helpers/notificationIcons";
import { invoke } from "@tauri-apps/api/core";

// Debug helpers — only exposed in development builds
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  (window as unknown as Record<string, unknown>).__clearNotifications = async () => {
    const { clearAllNotifications } = await import('@/app/lib/helpers/notificationsDb');
    await clearAllNotifications();
    console.log('All notifications cleared from database!');
  };

  (window as unknown as Record<string, unknown>).__debugNotifications = async (userAddress?: string) => {
    try {
      const notifications = await invoke<NotificationRow[]>("list_notifications", {
        userAddress: userAddress || "system",
        limit: 1000,
      });
      console.log("=== NOTIFICATIONS DEBUG ===");
      console.log(`Filter: ${userAddress || "ALL USERS"}`);
      console.log(`Total notifications: ${notifications.length}`);
      notifications.forEach((n: NotificationRow, idx: number) => {
        console.log(`[${idx}]`, n);
      });
      console.log("======================");
    } catch (error) {
      console.error("Failed to debug notifications:", error);
    }
  };
}

export const notificationsAtom = atom<UiNotification[]>([]);

// Atom to store enabled notification types
export const enabledNotificationTypesAtom = atom<string[]>([]);

// Atom to refresh the enabled notification types
export const refreshEnabledTypesAtom = atom(null, async (_, set) => {
  const types = await getEnabledNotificationTypes();
  set(enabledNotificationTypesAtom, types);
});

/** Map one Rust notification row to the UI view model. */
function mapRow(r: NotificationRow): UiNotification {
  const timestamp = Number(r.creationTime);
  return {
    id: Number(r.id),
    icon: (r.notificationType ? iconMap[r.notificationType] : undefined) ?? Icons.Document,
    type: r.notificationType ?? "",
    subType: r.notificationSubtype || "",
    title: r.titleText ?? "",
    description: r.description ?? "",
    buttonText: r.linkText ?? "",
    buttonLink: r.link ?? "",
    releaseNotes: typeof r.releaseNotes === "string" ? r.releaseNotes : "",
    unread: r.isUnread === true,
    timestamp,
    // Fallback display if the TimeAgo component can't render the timestamp.
    time: isNaN(timestamp) ? "Unknown date" : new Date(timestamp).toLocaleString(),
  };
}

/**
 * Pure row → view transform shared by the bell menu and the notifications page.
 *
 * A row is visible when its `notificationType` is one of the user's enabled
 * category labels, OR it is a `"Hippius"` system row (always shown). Returns the
 * visible list together with its unread tally so the bell badge and the list are
 * computed from one source and can never disagree.
 */
export function buildNotificationView(
  rows: NotificationRow[],
  enabledTypes: string[],
): { notifications: UiNotification[]; unreadCount: number } {
  const notifications = rows
    .map(mapRow)
    .filter((n) => (n.type !== "" && enabledTypes.includes(n.type)) || n.type === "Hippius");
  const unreadCount = notifications.filter((n) => n.unread).length;
  return { notifications, unreadCount };
}

// Fetch + rebuild the list/badge in one call. Intentionally takes NO frontend
// address: Rust scopes `list_notifications` to the signed-in session account and
// ignores any caller-supplied address (see notifications/crud.rs). The previous
// `if (!userAddress) return []` guard short-circuited the fetch whenever the
// frontend address lagged the Rust session — a restored mnemonic session exposes
// no `oauthSession` and `polkadotAddress` is briefly null during boot — leaving
// the bell stuck on "Nothing here" while the database held rows. Always fetch and
// let Rust scope.
export const refreshNotificationsAtom = atom(null, async (_get, set) => {
  const enabledTypes = await getEnabledNotificationTypes();
  set(enabledNotificationTypesAtom, enabledTypes);

  const rows = await listNotifications(100);
  const { notifications, unreadCount } = buildNotificationView(rows, enabledTypes);

  set(notificationsAtom, notifications);
  set(unreadCountAtom, unreadCount);
});

// Clear the in-memory notification view immediately (no I/O). Used on account
// switch / logout so a previous account's cached notifications cannot render
// under the new session while the async refresh is still in flight. Per-account
// isolation is enforced in Rust (`list_notifications` is session-scoped); this
// only prevents a stale flash in the UI.
export const clearNotificationsAtom = atom(null, (_get, set) => {
  set(notificationsAtom, []);
  set(unreadCountAtom, 0);
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
  // Scoped to the session account in Rust; no frontend address needed.
  await markAllRead();
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
