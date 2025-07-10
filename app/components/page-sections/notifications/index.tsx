"use client";

import React, { useState } from "react";
import { Icons } from "../../ui";
import * as Switch from "@radix-ui/react-switch";
import DashboardTitleWrapper from "../../dashboard-title-wrapper";
import TabList from "../../ui/tabs/tab-list";
import NotificationList from "./NotificationList";
import NotificationDetailView from "./NotificationDetailView";

const Notifications = () => {
  const [activeTab, setActiveTab] = useState("All");
  const [selectedNotificationId, setSelectedNotificationId] = useState<
    number | null
  >(null);
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

  // Sample notifications with additional fields for detail view
  const notifications = [
    {
      id: 1,
      icon: Icons.WalletAdd,
      type: "Blockchain",
      text: "Sync complete! Your data is now on the blockchain.",
      description:
        "Your data is now securely stored on the blockchain. This ensures that your information is immutable and transparent.",
      title: "Blockchain Sync Complete",
      time: "10 min ago",
      buttonText: "See",
      buttonLink: "#",
      unread: true,
    },
    {
      id: 2,
      icon: Icons.DocumentText,
      type: "Hippius",
      text: "Hey there! Just a quick update from the Hippius crew.",
      description:
        "We've made some improvements to our platform based on your feedback. Check out the latest features and let us know what you think!",
      title: "Update from Hippius",
      time: "1 hour ago",
      buttonText: "View",
      buttonLink: "#",
      unread: false,
    },
    {
      id: 3,
      icon: Icons.Document,
      type: "Subscription",
      text: "Your subscription has ended. Renew now to keep enjoying our services.",
      description:
        "Your subscription has come to an end, which means access to premium features is currently paused. But no worries — you can renew in just a few clicks and jump right back in. Don't miss out on the tools and perks that help you stay ahead.",
      title:
        "Your subscription has ended. Renew now to keep enjoying our services.",
      time: "10 min ago",
      buttonText: "Renew Now",
      buttonLink: "#",
      unread: true,
    },
  ];

  // Filter notifications if onlyShowUnread is true
  const filteredNotifications = onlyShowUnread
    ? notifications.filter((n) => n.unread)
    : notifications;

  const selectedNotification = selectedNotificationId
    ? filteredNotifications.find(
        (notification) => notification.id === selectedNotificationId
      )
    : null;

  const detailViewData = selectedNotification
    ? {
        icon: selectedNotification.icon,
        type: selectedNotification.type,
        title: selectedNotification.title || selectedNotification.text,
        description:
          selectedNotification.description || selectedNotification.text,
        time: selectedNotification.time,
        actionText: selectedNotification.buttonText,
        actionLink:
          selectedNotification.buttonLink || selectedNotification.buttonLink,
      }
    : null;

  // Handler for "Mark all as Read"
  const handleMarkAllAsRead = () => {
    // Implement your logic here
    // For demo, you might want to update the notifications state if it's stateful
  };

  // Handler for "Notification Setting"
  const handleNotificationSetting = () => {
    // Implement your logic here
  };

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
          className="px-4 py-2.5 bg-grey-90 rounded hover:bg-grey-80 text-grey-10 leading-5 text-[14px] font-medium transition-colors"
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
        <NotificationList
          notifications={filteredNotifications}
          selectedNotificationId={selectedNotificationId}
          onSelectNotification={setSelectedNotificationId}
        />
        <NotificationDetailView selectedNotification={detailViewData} />
      </div>
    </DashboardTitleWrapper>
  );
};

export default Notifications;
