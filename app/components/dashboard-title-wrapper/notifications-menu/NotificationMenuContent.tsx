"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import NotificationMenuHeader from "./NotificationMenuHeader";
import NotificationOptionSelect from "./NotificationOptionSelect";
import NotificationMenuList from "./NotificationMenuList";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useSetAtom } from "jotai";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";
import { toast } from "sonner";
import NoNotificationsFound from "../../page-sections/notifications/NoNotificationsFound";
import NotificationMenuFooter from "./NotificationMenuFooter";

interface Props {
  count: number;
  onClose?: () => void;
}

const notificationOptions = [
  { label: "View All", value: "all" },
  { label: "Credits", value: "credits" },
  { label: "Files", value: "files" },
];

const NotificationMenuContent: React.FC<Props> = ({ count, onClose }) => {
  const [selected, setSelected] = useState(notificationOptions[0].value);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);

  const router = useRouter();

  // shared store
  const { notifications, refresh, markRead, markUnread, markAllRead } =
    useNotifications();

  // keep list up-to-date every time the menu opens
  useEffect(() => {
    refresh();
  }, [refresh]);

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

  return (
    <>
      <NotificationMenuHeader count={count} onClose={onClose} />

      <div className="p-4 flex flex-col gap-4">
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
        {visible.length === 0 ? (
          <NoNotificationsFound heightClassName="h-[340px]" />
        ) : (
          <NotificationMenuList
            notifications={visible}
            onSelectNotification={handleSelect}
            onReadStatusChange={handleReadToggle}
          />
        )}
      </div>
      <NotificationMenuFooter />
    </>
  );
};

export default NotificationMenuContent;
