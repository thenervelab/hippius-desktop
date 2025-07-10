/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import React, { useEffect, useState } from "react";
import { Icons } from "../../ui";
import * as Switch from "@radix-ui/react-switch";
import DashboardTitleWrapper from "../../dashboard-title-wrapper";
import TabList from "../../ui/tabs/tab-list";
import NotificationList from "./NotificationList";
import NotificationDetailView from "./NotificationDetailView";
import NoNotificationsFound from "./NoNotificationsFound";
import { UiNotification } from "./types";
import {
  listNotifications,
  markAllRead,
  markRead,
  markUnread,
} from "@/app/lib/helpers/notificationsDb";
import { IconComponent } from "@/app/lib/types";
import { Toaster, toast } from "sonner";
// match DB → UI
const iconMap: Record<string, IconComponent> = {
  Credits: Icons.WalletAdd,
  Files: Icons.DocumentText,
  Hippius: Icons.HippiusLogo,
};
const Notifications = () => {
  const [activeTab, setActiveTab] = useState("All");
  const [selectedNotificationId, setSelectedNotificationId] = useState<
    number | null
  >(null);
  const [notifications, setNotifications] = useState<UiNotification[]>([]);

  const [onlyShowUnread, setOnlyShowUnread] = useState(false);

  const tabs = [
    {
      tabName: "All",
      icon: <Icons.MaximizeCircle />,
      isActive: true,
    },
    {
      tabName: "Credits",
      icon: <Icons.WalletAdd />,
    },
    {
      tabName: "Files",
      icon: <Icons.DocumentText />,
    },
  ];

  const fetchNotifications = async () => {
    const rows = await listNotifications(100); // helper returns sql.js rows

    const mapped: UiNotification[] = rows.map((r: any[]) => {
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

    console.log("Fetched notifications:", mapped);
    setNotifications(mapped);
  };

  useEffect(() => {
    fetchNotifications();
  }, []);

  // Handle toggling notification read status
  const handleReadStatusChange = async (id: number, isUnread: boolean) => {
    try {
      if (isUnread) {
        await markUnread(id);
      } else {
        await markRead(id);
      }

      // Update the local state to reflect changes
      setNotifications((prevNotifications) =>
        prevNotifications.map((notification) =>
          notification.id === id
            ? { ...notification, unread: isUnread }
            : notification
        )
      );
      toast.success(isUnread ? "Marked as unread" : "Marked as read");
    } catch (error) {
      console.error("Failed to update notification read status:", error);
    }
  };

  // Filter notifications based on active tab and read status
  const filteredNotifications = notifications
    .filter(
      (notification) =>
        // First filter by tab selection
        activeTab === "All" || notification.type === activeTab
    )
    .filter(
      (notification) =>
        // Then filter by read status if needed
        !onlyShowUnread || notification.unread
    );

  const selectedNotification = selectedNotificationId
    ? filteredNotifications.find(
        (notification) => notification.id === selectedNotificationId
      )
    : null;

  const detailViewData = selectedNotification
    ? {
        id: selectedNotification.id,
        icon: selectedNotification.icon,
        type: selectedNotification.type,
        title: selectedNotification.title || "",
        description: selectedNotification.description || "",
        time: selectedNotification.time,
        timestamp: selectedNotification.timestamp,
        actionText: selectedNotification.buttonText,
        actionLink:
          selectedNotification.buttonLink || selectedNotification.buttonLink,
        unread: selectedNotification.unread,
      }
    : null;

  // Handler for "Mark all as Read"
  const handleMarkAllAsRead = async () => {
    try {
      // Call the database function to mark all as read
      await markAllRead();

      // Update the local state to reflect changes
      setNotifications((prevNotifications) =>
        prevNotifications.map((notification) => ({
          ...notification,
          unread: false,
        }))
      );

      toast.success("All notifications marked as read!");
    } catch (error) {
      console.error("Failed to mark all notifications as read:", error);
      // Optional: Show error notification or toast here
    }
  };

  // Handler for "Notification Setting"
  const handleNotificationSetting = () => {
    // Implement your logic here
  };

  // Reset selected notification when changing tabs if it's no longer visible
  useEffect(() => {
    if (
      selectedNotificationId &&
      !filteredNotifications.some((n) => n.id === selectedNotificationId)
    ) {
      setSelectedNotificationId(null);
    }
  }, [
    activeTab,
    onlyShowUnread,
    filteredNotifications,
    selectedNotificationId,
  ]);

  return (
    <DashboardTitleWrapper mainText="Notifications">
      <div className="mt-6 flex justify-end gap-4">
        <TabList
          tabs={tabs}
          width="min-w-[89px]"
          height="h-[32px]"
          gap="gap-1"
          activeTab={activeTab}
          onTabChange={setActiveTab}
          className="max-w-fit p-1 border border-grey-80"
        />

        {/* Only show unread switch */}
        <label className="flex items-center gap-3 cursor-pointer select-none">
          <span className="text-grey-10 font-medium text-sm leading-5">
            Only show unread
          </span>
          <Switch.Root
            checked={onlyShowUnread}
            onCheckedChange={setOnlyShowUnread}
            className="w-[54px] h-[26px] bg-grey-90 rounded-full relative data-[state=checked]:bg-primary-50 transition-all outline-none border border-grey-80"
          >
            <Switch.Thumb className="block w-[18px] h-[18px] bg-primary-50 rounded-full shadow transition-transform duration-100 translate-x-0.5 data-[state=checked]:translate-x-8 data-[state=checked]:bg-white" />
          </Switch.Root>
        </label>

        {/* Mark all as Read */}
        <button
          className="px-4 py-2.5 bg-grey-90 rounded hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white text-grey-10 leading-5 text-[14px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
          onClick={handleMarkAllAsRead}
        >
          Mark all as Read
        </button>

        {/* Notification Setting */}
        <button
          className="px-4 py-2.5 bg-grey-90 rounded hover:bg-grey-80 text-grey-10 leading-5 text-[14px] font-medium flex items-center gap-2 transition-colors"
          onClick={handleNotificationSetting}
        >
          <Icons.Setting className="size-4" />
          Notification Setting
        </button>
      </div>

      <div className="mt-4 flex gap-4">
        {filteredNotifications.length === 0 ? (
          <NoNotificationsFound />
        ) : (
          <>
            <NotificationList
              notifications={filteredNotifications}
              selectedNotificationId={selectedNotificationId}
              onSelectNotification={setSelectedNotificationId}
              onReadStatusChange={handleReadStatusChange}
            />
            <NotificationDetailView
              onReadStatusChange={handleReadStatusChange}
              selectedNotification={detailViewData}
            />
          </>
        )}
      </div>
      <Toaster />
    </DashboardTitleWrapper>
  );
};

export default Notifications;
