"use client";

import { useEffect, useState, useMemo } from "react";
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

const CATEGORY_DISPLAY: Record<string, string> = {
  Files: "Storage",
};

interface Props {
  count: number;
  onClose?: () => void;
}

const NotificationMenuContent: React.FC<Props> = ({ count, onClose }) => {
  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const [activeCategory, setActiveCategory] = useState("All");
  const router = useRouter();

  const { notifications, refresh, markRead, markUnread } = useNotifications();

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshEnabledTypes();
  }, [refreshEnabledTypes]);

  // Reset to "All" if the active category gets disabled
  useEffect(() => {
    if (activeCategory !== "All" && !enabledTypes.includes(activeCategory)) {
      setActiveCategory("All");
    }
  }, [enabledTypes, activeCategory]);

  const categoryOptions = useMemo(() => [
    { value: "All", label: "All" },
    ...enabledTypes.map((type) => ({
      value: type,
      label: CATEGORY_DISPLAY[type] ?? type,
    })),
  ], [enabledTypes]);

  const filteredNotifications = useMemo(
    () =>
      activeCategory === "All"
        ? notifications
        : notifications.filter((n) => n.type === activeCategory),
    [notifications, activeCategory],
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
  };

  const handleOpenSettings = () => {
    onClose?.();
    router.push("/settings?section=notifications");
  };

  return (
    <>
      <NotificationMenuHeader
        count={count}
        onClose={onClose}
        activeCategory={activeCategory}
        onCategoryChange={setActiveCategory}
        categoryOptions={categoryOptions}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {enabledTypes.length === 0 ? (
          <div className="p-4">
            <NoNotificationsEnabled
              heightClassName="min-h-[15rem]"
              onOpenSettings={handleOpenSettings}
            />
          </div>
        ) : filteredNotifications.length === 0 ? (
          <NoNotificationsFound heightClassName="min-h-[15rem]" />
        ) : (
          <NotificationMenuList
            notifications={filteredNotifications}
            onSelectNotification={handleSelect}
            onReadStatusChange={handleReadToggle}
            onClose={onClose}
          />
        )}
      </div>

      {filteredNotifications.length > 0 && (
        <NotificationMenuFooter onClose={onClose} />
      )}
    </>
  );
};

export default NotificationMenuContent;
