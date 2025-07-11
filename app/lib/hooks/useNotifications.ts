import { useAtom, useSetAtom } from "jotai";
import {
  notificationsAtom,
  refreshNotificationsAtom,
  markReadAtom,
  markUnreadAtom,
  markAllReadAtom,
} from "@/components/page-sections/notifications/notificationStore";

export function useNotifications() {
  const [notifications] = useAtom(notificationsAtom);
  const refresh = useSetAtom(refreshNotificationsAtom);
  const markRead = useSetAtom(markReadAtom);
  const markUnread = useSetAtom(markUnreadAtom);
  const markAllRead = useSetAtom(markAllReadAtom);

  return { notifications, refresh, markRead, markUnread, markAllRead };
}
