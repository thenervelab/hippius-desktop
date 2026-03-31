/* eslint-disable @typescript-eslint/no-explicit-any */
import { invoke } from "@tauri-apps/api/core";

/* ── Notification Preferences ── */

export async function getNotificationPreferences() {
  try {
    return await invoke<
      Array<{ id: string; label: string; description: string; enabled: boolean }>
    >("get_local_notification_preferences");
  } catch (error) {
    console.error("Failed to get notification preferences:", error);
    return [];
  }
}

export async function updateAllNotificationPreferences(
  prefMap: Record<string, boolean>,
) {
  try {
    const preferences = Object.entries(prefMap).map(([id, enabled]) => ({
      id,
      enabled,
    }));
    await invoke("update_local_notification_preferences", { preferences });
    return true;
  } catch (error) {
    console.error("Failed to update notification preferences:", error);
    return false;
  }
}

export async function getEnabledNotificationTypes(): Promise<string[]> {
  try {
    return await invoke<string[]>("get_local_enabled_notification_types");
  } catch (error) {
    console.error("Failed to get enabled notification types:", error);
    return [];
  }
}

/* ── Notifications CRUD ── */

export async function addNotification({
  userAddress,
  notificationType,
  notificationSubtype = "",
  notificationTitleText,
  notificationDescription,
  notificationLinkText,
  notificationLink,
  notificationReleaseNotes = "",
}: {
  userAddress: string;
  notificationType: string;
  notificationSubtype?: string;
  notificationTitleText: string;
  notificationDescription: string;
  notificationLinkText: string;
  notificationLink: string;
  notificationReleaseNotes?: string;
}) {
  try {
    await invoke("add_notification", {
      userAddress,
      notificationType,
      notificationSubtype,
      titleText: notificationTitleText,
      description: notificationDescription,
      linkText: notificationLinkText,
      link: notificationLink,
      releaseNotes: notificationReleaseNotes,
    });
    console.log(
      `[NotificationsDB] Added notification for ${userAddress}: ${notificationSubtype || notificationType}`,
    );
  } catch (error) {
    console.error("Failed to add notification:", error);
  }
}

export async function listNotifications(userAddress: string, limit = 50) {
  try {
    return await invoke<any[]>("list_notifications", { userAddress, limit });
  } catch (error) {
    console.error("Failed to list notifications:", error);
    return [];
  }
}

export async function markRead(id: number) {
  try {
    await invoke("mark_notification_read", { id });
  } catch (error) {
    console.error("Failed to mark notification as read:", error);
  }
}

export async function markUnread(id: number) {
  try {
    await invoke("mark_notification_unread", { id });
  } catch (error) {
    console.error("Failed to mark notification as unread:", error);
  }
}

export async function markAllRead(userAddress: string) {
  try {
    await invoke("mark_all_notifications_read", { userAddress });
    return true;
  } catch (error) {
    console.error("Failed to mark all notifications as read:", error);
    return false;
  }
}

export async function unreadCount(userAddress: string): Promise<number> {
  try {
    return await invoke<number>("get_unread_count", { userAddress });
  } catch (error) {
    console.error("Failed to get unread count:", error);
    return 0;
  }
}

export async function deleteNotification(id: number) {
  try {
    await invoke("delete_notification", { id });
    return true;
  } catch (error) {
    console.error("Failed to delete notification:", error);
    return false;
  }
}

export async function deleteAllNotifications(userAddress: string) {
  try {
    await invoke("delete_all_notifications", { userAddress });
    return true;
  } catch (error) {
    console.error("Failed to delete all notifications:", error);
    return false;
  }
}

export async function deleteSystemNotificationByVersion(version: string) {
  try {
    await invoke("delete_system_notification_by_version", { version });
    console.log(
      `[NotificationsDB] System notification for version ${version} marked as deleted`,
    );
    return true;
  } catch (error) {
    console.error("Failed to delete system notification by version:", error);
    return false;
  }
}

export async function clearAllNotifications() {
  try {
    await invoke("clear_all_notifications");
    console.log("[NotificationsDB] All notifications cleared from database");
    return true;
  } catch (error) {
    console.error("Failed to clear all notifications:", error);
    return false;
  }
}

/* ── Credit notification helpers ── */

export async function creditAlreadyNotified(ts: string): Promise<boolean> {
  try {
    return await invoke<boolean>("credit_already_notified", { timestamp: ts });
  } catch (error) {
    console.error("Failed to check credit notification:", error);
    return false;
  }
}

export async function lowCreditSubtypeExists(
  subtype: string,
): Promise<boolean> {
  try {
    return await invoke<boolean>("low_credit_subtype_exists", { subtype });
  } catch (error) {
    console.error("Failed to check low credit subtype:", error);
    return false;
  }
}

export async function hasActiveLowCreditNotification(): Promise<boolean> {
  try {
    return await invoke<boolean>("has_active_low_credit_notification");
  } catch (error) {
    console.error("Failed to check active low credit notification:", error);
    return false;
  }
}

export async function getLastDeletedLowCreditNotification(): Promise<{
  deletedAt: number;
} | null> {
  try {
    const result = await invoke<number | null>("get_last_deleted_low_credit_time");
    if (result === null) return null;
    return { deletedAt: result };
  } catch (error) {
    console.error("Failed to get last deleted low credit notification:", error);
    return null;
  }
}

export async function hippusVersionNotificationExists(
  version: string,
): Promise<boolean> {
  try {
    return await invoke<boolean>("hippius_version_notification_exists", {
      version,
    });
  } catch (error) {
    console.error("Failed to check hippius version notification:", error);
    return false;
  }
}

/* ── App state ── */

export async function isFirstTime(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_first_time");
  } catch (error) {
    console.error("Failed to check first time status:", error);
    return true;
  }
}

export async function markFirstTimeSeen() {
  try {
    await invoke("mark_first_time_seen");
  } catch (error) {
    console.error("Failed to mark first time seen:", error);
  }
}

export async function isAboveHalfCredit(): Promise<boolean> {
  try {
    return await invoke<boolean>("get_is_above_half_credit");
  } catch (error) {
    console.error("Failed to check above half credit status:", error);
    return false;
  }
}

export async function updateIsAboveHalfCredit(isAboveHalfCredit: boolean) {
  try {
    await invoke("update_is_above_half_credit", { value: isAboveHalfCredit });
  } catch (error) {
    console.error("Failed to update above half credit status:", error);
  }
}
