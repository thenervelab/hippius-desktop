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
import { deleteAllNotifications } from "@/app/lib/helpers/notificationsDb";
import ArchiveAllConfirmationDialog from "@/components/page-sections/notifications/ArchiveAllConfirmationDialog";

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
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);

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

  const { notifications, refresh, markRead, markUnread, markAllRead } =
    useNotifications();

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  useEffect(() => {
    if (
      notificationOptions.length > 0 &&
      !notificationOptions.some((opt) => opt.value === selected)
    ) {
      setSelected(notificationOptions[0].value);
    }
  }, [notificationOptions, selected]);

  const visible = notifications.filter((n) =>
    selected === "all" ? true : n.type.toLowerCase() === selected
  );

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
    toast.success(unread ? "Marked as unread" : "Marked as read");
    refreshUnread();
  };

  const handleAllRead = async () => {
    await markAllRead();
    toast.success("All notifications marked as read");
    refreshUnread();
  };

  const handleArchiveAllConfirm = async () => {
    setIsArchiving(true);
    try {
      await deleteAllNotifications();
      await refresh();
      await refreshUnread();
      toast.success("All notifications archived");
    } catch (error) {
      console.log("Delete all notifications error:", error);
      toast.error("Failed to archive notifications");
    } finally {
      setIsArchiving(false);
      setIsArchiveDialogOpen(false);
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

      <div className="p-4 flex flex-col gap-4">
        {notificationOptions.length > 0 && (
          <div className="flex justify-between">
            <NotificationOptionSelect
              options={notificationOptions}
              value={selected}
              onChange={setSelected}
            />
            <div className="flex gap-2">
              <button
                className="px-3 py-2 items-center text-sm rounded-md text-grey-70 hover:bg-gray-100 active:bg-gray-200 active:text-gray-700 focus:bg-gray-200 focus:text-gray-700 leading-5 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-gray-300"
                onClick={handleAllRead}
              >
                Mark all as Read
              </button>
              <button
                className="px-3 py-2 items-center text-sm rounded-md text-grey-70 hover:bg-error-50 hover:text-white active:bg-error-60 leading-5 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-error-50"
                onClick={() => setIsArchiveDialogOpen(true)}
                title="Remove all notifications"
              >
                Delete All
              </button>
            </div>
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

      <ArchiveAllConfirmationDialog
        open={isArchiveDialogOpen}
        onClose={() => setIsArchiveDialogOpen(false)}
        onConfirm={handleArchiveAllConfirm}
        loading={isArchiving}
      />
    </>
  );
};

export default NotificationMenuContent;
