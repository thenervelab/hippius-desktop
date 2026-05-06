"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import NotificationMenuHeader from "./NotificationMenuHeader";
import NotificationMenuList from "./NotificationMenuList";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useSetAtom, useAtom } from "jotai";
import {
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import NoNotificationsFound from "@/components/page-sections/notifications/NoNotificationsFound";
import NoNotificationsEnabled from "@/components/page-sections/notifications/NoNotificationsEnabled";
import NotificationMenuFooter from "./NotificationMenuFooter";
import {
  settingsDialogOpenAtom,
  activeSettingsTabAtom,
} from "@/app/components/sidebar/sideBarAtoms";

interface Props {
  count: number;
  onClose?: () => void;
}

const NotificationMenuContent: React.FC<Props> = ({ count, onClose }) => {
  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const router = useRouter();
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setActiveSettingsTab = useSetAtom(activeSettingsTabAtom);

  const { notifications, refresh, markRead, markUnread } = useNotifications();

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  const handleSelect = async (id: number) => {
    onClose?.();
    router.push(`/notifications?selected=${id}`);
  };

  const handleReadToggle = async (id: number, unread: boolean) => {
    if (unread) {
      await markUnread(id);
    } else {
      await markRead(id);
    }
  };

  const handleOpenSettings = () => {
    onClose?.();
    setActiveSettingsTab("Notifications");
    setSettingsDialogOpen(true);
  };

  return (
    <>
      <NotificationMenuHeader count={count} onClose={onClose} />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {enabledTypes.length === 0 ? (
          <div className="p-4">
            <NoNotificationsEnabled
              heightClassName="min-h-[15rem]"
              onOpenSettings={handleOpenSettings}
            />
          </div>
        ) : notifications.length === 0 ? (
          <NoNotificationsFound heightClassName="min-h-[15rem]" />
        ) : (
          <NotificationMenuList
            notifications={notifications}
            onSelectNotification={handleSelect}
            onReadStatusChange={handleReadToggle}
            onClose={onClose}
          />
        )}
      </div>

      <NotificationMenuFooter onClose={onClose} />
    </>
  );
};

export default NotificationMenuContent;
