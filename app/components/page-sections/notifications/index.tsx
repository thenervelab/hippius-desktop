"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Icons } from "@/components/ui";
import * as Switch from "@radix-ui/react-switch";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import TabList from "@/components/ui/tabs/TabList";
import NotificationList from "./NotificationList";
import NotificationDetailView from "./NotificationDetailView";
import NoNotificationsFound from "./NoNotificationsFound";
import NoNotificationsEnabled from "./NoNotificationsEnabled";
import { Toaster, toast } from "sonner";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { UiNotification } from "./types";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useSearchParams } from "next/navigation";
import {
  settingsDialogOpenAtom,
  activeSettingsTabAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import { iconMap } from "@/app/lib/helpers/notificationIcons";
import { deleteAllNotifications } from "@/app/lib/helpers/notificationsDb";

const Notifications = () => {
  const [activeTab, setActiveTab] = useState("All");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);
  const [settingsDialogOpen] = useAtom(settingsDialogOpenAtom);

  const searchParams = useSearchParams();
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setActiveSettingsTab = useSetAtom(activeSettingsTabAtom);

  const refreshUnread = useSetAtom(refreshUnreadCountAtom);

  const { notifications, refresh, markRead, markUnread, markAllRead } =
    useNotifications();

  // Dynamically build tabs based on enabled notification types
  // Only include "All" tab if there's at least one enabled notification type
  const tabs = useMemo(
    () => [
      ...(enabledTypes.length > 0
        ? [{ tabName: "All", icon: <Icons.MaximizeCircle /> }]
        : []),
      ...enabledTypes.map((type) => ({
        tabName: type,
        icon: iconMap[type] ? (
          React.createElement(iconMap[type])
        ) : (
          <Icons.Document />
        ),
      })),
    ],
    [enabledTypes]
  );

  // A) Run once on mount (already OK)
  useEffect(() => {
    refresh();
    refreshEnabledTypes();
  }, [refresh, refreshEnabledTypes]);

  // New: remove window event listeners. We refetch directly where needed.
  // useEffect(() => {
  //   const onUpdated = () => {
  //     refresh();
  //     refreshUnread();
  //   };
  //   window.addEventListener("notifications:updated", onUpdated);
  //   return () => window.removeEventListener("notifications:updated", onUpdated);
  // }, [refresh, refreshUnread]);

  // B) Re-fetch types when the settings dialog closes/opens
  useEffect(() => {
    if (!settingsDialogOpen) {
      refreshEnabledTypes();
    }
    // do NOT depend on enabledTypes/tabs here
  }, [settingsDialogOpen, refreshEnabledTypes]);

  // C) Handle tab correction separately, without calling refreshEnabledTypes()
  useEffect(() => {
    if (
      (activeTab === "All" && enabledTypes.length === 0) ||
      (activeTab !== "All" && !enabledTypes.includes(activeTab))
    ) {
      setActiveTab(tabs[0]?.tabName || "");
    }
  }, [enabledTypes, activeTab, tabs]);

  // Update active tab if tabs change and current active tab is no longer available
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((tab) => tab.tabName === activeTab)) {
      setActiveTab(tabs[0].tabName);
    }
  }, [tabs, activeTab]);

  useEffect(() => {
    const raw = searchParams.get("selected");
    if (!raw) return;

    const id = Number(raw);
    if (Number.isNaN(id)) return;

    setSelectedId(id);
    markRead(id).then(() => {
      refreshUnread();
    });
    // remove "selected" from search params after using it
    const params = new URLSearchParams(searchParams.toString());
    params.delete("selected");
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}?${params.toString()}`
    );
  }, [searchParams, markRead, refreshUnread]);

  // attach icons
  const items: UiNotification[] = notifications.map((n) => ({
    ...n,
    icon: iconMap[n.type] ?? Icons.Document,
  }));

  // filtering
  const visible = items
    .filter((n) => activeTab === "All" || n.type === activeTab)
    .filter((n) => !onlyUnread || n.unread);

  const onReadToggle = async (id: number, unread: boolean) => {
    if (unread) {
      await markUnread(id);
    } else {
      await markRead(id);
    }

    toast.success(unread ? "Marked as unread" : "Marked as read");
    refreshUnread();
  };

  const onItemClick = (id: number) => {
    markRead(id).then(refreshUnread); // mark read then update badge
    setSelectedId(id);
  };

  const selected = selectedId ? visible.find((n) => n.id === selectedId) : null;

  const detail = selected
    ? {
      id: selected.id,
      icon: selected.icon,
      type: selected.type,
      title: selected.title ?? "",
      description: selected.description ?? "",
      time: selected.time,
      timestamp: selected.timestamp,
      actionText: selected.buttonText,
      actionLink: selected.buttonLink,
      unread: selected.unread,
    }
    : null;

  const handleAllRead = async () => {
    await markAllRead();
    toast.success("All notifications marked as read");
    refreshUnread();
  };

  // New: archive all
  const handleArchiveAll = async () => {
    await deleteAllNotifications();
    toast.success("All notifications archived");
    await refresh();
    await refreshUnread();
    // Removed window.dispatchEvent. We refetch directly.
  };

  const handleOpenSettings = () => {
    // Set the active tab to "Notifications" before opening
    setActiveSettingsTab("Notifications");
    setSettingsDialogOpen(true);
  };

  // Refresh the notifications list
  const handleRefreshNotifications = useCallback(() => {
    refresh();
  }, [refresh]);

  return (
    <DashboardTitleWrapper mainText="Notifications">
      {/* controls */}
      <div className="mt-6 flex justify-end gap-4">
        {tabs.length > 0 && (
          <>
            <TabList
              tabs={tabs}
              width="min-w-[89px]"
              height="h-[32px]"
              gap="gap-1"
              activeTab={activeTab}
              onTabChange={setActiveTab}
              className="max-w-fit p-1 border border-grey-80"
            />

            <label className="flex items-center gap-3 cursor-pointer select-none">
              <span className="text-grey-10 font-medium text-sm leading-5">
                Only show unread
              </span>
              <Switch.Root
                checked={onlyUnread}
                onCheckedChange={setOnlyUnread}
                className="w-[54px] h-[26px] bg-grey-90 rounded-full relative data-[state=checked]:bg-primary-50 transition-all outline-none border border-grey-80"
              >
                <Switch.Thumb className="block w-[18px] h-[18px] bg-primary-50 rounded-full shadow transition-transform duration-100 translate-x-0.5 data-[state=checked]:translate-x-8 data-[state=checked]:bg-white" />
              </Switch.Root>
            </label>

            <button
              className="px-4 py-2.5 items-center bg-grey-90 rounded hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white text-grey-10 leading-5 text-[14px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50"
              onClick={handleAllRead}
            >
              Mark all as Read
            </button>
            {/* New: Archive All */}
            <button
              className="px-4 py-2.5 items-center bg-grey-90 rounded hover:bg-error-60 hover:text-white active:bg-error-70 active:text-white text-grey-10 leading-5 text-[14px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-error-50"
              onClick={handleArchiveAll}
              title="Remove all notifications"
            >
              Archive All
            </button>
          </>
        )}
        <button
          className="px-4 py-2.5 bg-grey-90 rounded text-grey-10 leading-5 text-[14px] font-medium flex items-center gap-2 transition-colors hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white focus:outline-none focus:ring-2 focus:ring-primary-50"
          onClick={handleOpenSettings}
        >
          <Icons.Setting className="size-4" />
          Notification Setting
        </button>
      </div>

      {/* list + detail */}
      <div className="mt-4 flex gap-4 w-full">
        {enabledTypes.length === 0 ? (
          <NoNotificationsEnabled onOpenSettings={handleOpenSettings} />
        ) : visible.length === 0 ? (
          <NoNotificationsFound />
        ) : (
          <>
            <NotificationList
              notifications={visible}
              selectedNotificationId={selectedId}
              onSelectNotification={onItemClick}
              onReadStatusChange={onReadToggle}
              onRefresh={handleRefreshNotifications}
            />
            <NotificationDetailView
              selectedNotification={detail}
              onReadStatusChange={onReadToggle}
            />
          </>
        )}
      </div>
      <Toaster />
    </DashboardTitleWrapper>
  );
};

export default Notifications;
