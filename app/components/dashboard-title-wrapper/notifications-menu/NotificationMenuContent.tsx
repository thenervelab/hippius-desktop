"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import NotificationMenuHeader from "./NotificationMenuHeader";
import NotificationOptionSelect from "./NotificationOptionSelect";
import NotificationMenuList from "./NotificationMenuList";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { toast } from "sonner";
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
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const router = useRouter();
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setActiveSettingsTab = useSetAtom(activeSettingsTabAtom);

  // Dynamic notification options - only include "View All" if there are enabled types
  const notificationOptions = useMemo(
    () => [
      ...(enabledTypes.length > 0 ? [{ label: "View All", value: "all" }] : []),
      ...enabledTypes.map((type) => ({
        label: type,
        value: type.toLowerCase(),
      })),
    ],
    [enabledTypes]
  );

  const [selected, setSelected] = useState(notificationOptions[0]?.value || "");

  // shared store
  const { notifications, refresh, markRead, markUnread, markAllRead } =
    useNotifications();

  // keep list up-to-date every time the menu opens
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load enabled notification types
  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  // Update selected value when options change
  useEffect(() => {
    if (
      notificationOptions.length > 0 &&
      !notificationOptions.some((opt) => opt.value === selected)
    ) {
      setSelected(notificationOptions[0].value);
    }
  }, [notificationOptions, selected]);

  // filtering (case-insensitive match)
  const visible = notifications.filter((n) =>
    selected === "all" ? true : n.type.toLowerCase() === selected
  );

  const handleSelect = async (id: number) => {
    onClose?.(); // close the portal
    router.push(`/notifications?selected=${id}`);
  };

  const handleReadToggle = async (id: number, unread: boolean) => {
    if (unread) {
      await markUnread(id);
    } else {
      await markRead(id);
    }
    toast.success(unread ? "Marked as unread" : "Marked as read");
    refreshUnread();
  };

  const handleAllRead = async () => {
    await markAllRead();
    toast.success("All notifications marked as read");
    refreshUnread();
  };

  const handleOpenSettings = () => {
    onClose?.(); // Close the menu
    // Set the active tab to "Notifications" before opening settings
    setActiveSettingsTab("Notifications");
    setSettingsDialogOpen(true);
  };

  return (
    <>
      <NotificationMenuHeader count={count} onClose={onClose} />

      <div className="p-4 flex flex-col gap-4">
        {notificationOptions.length > 0 && (
          <div className="flex justify-between">
            <NotificationOptionSelect
              options={notificationOptions}
              value={selected}
              onChange={setSelected}
            />
            <button
              className="px-3 py-2 items-center text-sm rounded-md text-grey-70 hover:bg-gray-100 active:bg-gray-200 active:text-gray-700 focus:bg-gray-200 focus:text-gray-700 leading-5 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-gray-300"
              onClick={handleAllRead}
            >
              Mark all as Read
            </button>
          </div>
        )}
        {enabledTypes.length === 0 ? (
          <NoNotificationsEnabled
            heightClassName="h-[340px]"
            onOpenSettings={handleOpenSettings}
          />
        ) : visible.length === 0 ? (
          <NoNotificationsFound heightClassName="h-[340px]" />
        ) : (
          <NotificationMenuList
            notifications={visible}
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
