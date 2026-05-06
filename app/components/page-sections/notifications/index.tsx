"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Icons } from "@/components/ui";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
import TabList from "@/components/ui/tabs/TabList";
import NotificationList from "./NotificationList";
import NotificationDetailView from "./NotificationDetailView";
import NoNotificationsFound from "./NoNotificationsFound";
import NoNotificationsEnabled from "./NoNotificationsEnabled";
import NotificationsSettingsDialog from "./NotificationsSettingsDialog";
import { toast } from "sonner";
import { useSetAtom, useAtom } from "jotai";
import {
  refreshUnreadCountAtom,
  enabledNotificationTypesAtom,
  refreshEnabledTypesAtom,
} from "@/components/page-sections/notifications/notificationStore";
import { UiNotification } from "./types";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useSearchParams } from "next/navigation";
import { iconMap } from "@/app/lib/helpers/notificationIcons";
import { deleteAllNotifications } from "@/app/lib/helpers/notificationsDb";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import ArchiveAllConfirmationDialog from "./ArchiveAllConfirmationDialog";
import NotificationHubStats from "./NotificationHubStats";
import { cn } from "@/app/lib/utils";

const Notifications = () => {
  const [activeTab, setActiveTab] = useState("All");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [enabledTypes] = useAtom(enabledNotificationTypesAtom);
  const refreshEnabledTypes = useSetAtom(refreshEnabledTypesAtom);

  const searchParams = useSearchParams();
  const { polkadotAddress, oauthSession } = useWalletAuth();

  const refreshUnread = useSetAtom(refreshUnreadCountAtom);

  const { notifications, refresh, markRead, markUnread, markAllRead } =
    useNotifications();

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

  useEffect(() => {
    refresh();
    refreshEnabledTypes();
  }, [refresh, refreshEnabledTypes]);

  useEffect(() => {
    if (
      (activeTab === "All" && enabledTypes.length === 0) ||
      (activeTab !== "All" && !enabledTypes.includes(activeTab))
    ) {
      setActiveTab(tabs[0]?.tabName || "");
    }
  }, [enabledTypes, activeTab, tabs]);

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
    const params = new URLSearchParams(searchParams.toString());
    params.delete("selected");
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}?${params.toString()}`
    );
  }, [searchParams, markRead, refreshUnread]);

  const items: UiNotification[] = notifications.map((n) => ({
    ...n,
    icon: iconMap[n.type] ?? Icons.Document,
  }));

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
    markRead(id).then(refreshUnread);
    setSelectedId(id);
  };

  const selected = selectedId ? visible.find((n) => n.id === selectedId) : null;

  const detail = selected
    ? {
        id: selected.id,
        icon: selected.icon,
        type: selected.type,
        subType: selected.subType,
        title: selected.title ?? "",
        description: selected.description ?? "",
        releaseNotes: selected.releaseNotes ?? "",
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

  const handleArchiveAllConfirm = async () => {
    const userAddress = oauthSession?.substrateAddress || polkadotAddress;
    if (!userAddress) {
      setIsArchiveDialogOpen(false);
      return;
    }
    setIsArchiving(true);
    try {
      await deleteAllNotifications(userAddress);
      await refresh();
      await refreshUnread();
      toast.success("All notifications deleted");
    } catch (error) {
      console.log("Delete all notifications error:", error);
      toast.error("Failed to delete notifications");
    } finally {
      setIsArchiving(false);
      setIsArchiveDialogOpen(false);
    }
  };

  const handleRefreshNotifications = useCallback(() => {
    refresh();
  }, [refresh]);

  return (
    <DashboardTitleWrapper
      mainText="Notifications Hub"
      subText="Store. Compute. Own your infrastructure."
    >
      {/* Stats header bar */}
      <div className="mt-4 flex items-center justify-end">
        <NotificationHubStats />
      </div>

      {/* Controls row */}
      <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
        {/* Left: type tabs */}
        {tabs.length > 0 && (
          <TabList
            tabs={tabs}
            width="min-w-[5.5625rem]"
            height="h-[2rem]"
            gap="gap-1"
            activeTab={activeTab}
            onTabChange={setActiveTab}
            className="max-w-fit p-1 border border-grey-80"
          />
        )}

        {/* Right: read-filter + actions */}
        {tabs.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {/* All / Unread pill toggle */}
            <div className="flex items-center rounded-lg border border-grey-80 overflow-hidden h-8">
              <button
                onClick={() => setOnlyUnread(false)}
                className={cn(
                  "px-3 h-full text-sm font-medium transition-colors",
                  !onlyUnread
                    ? "bg-primary-50 text-white"
                    : "text-grey-40 hover:text-grey-10 hover:bg-grey-95"
                )}
              >
                All
              </button>
              <button
                onClick={() => setOnlyUnread(true)}
                className={cn(
                  "px-3 h-full text-sm font-medium transition-colors border-l border-grey-80",
                  onlyUnread
                    ? "bg-primary-50 text-white"
                    : "text-grey-40 hover:text-grey-10 hover:bg-grey-95"
                )}
              >
                Unread
              </button>
            </div>

            {/* Mark all as read */}
            <button
              className="px-4 h-8 items-center bg-grey-95 rounded-lg hover:bg-primary-50 hover:text-white active:bg-primary-70 text-grey-10 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-grey-95 disabled:hover:text-grey-10"
              onClick={handleAllRead}
              disabled={visible.length === 0}
            >
              Mark all as read
            </button>

            {/* Notifications Settings */}
            <button
              className="px-4 h-8 bg-grey-95 rounded-lg text-grey-10 text-sm font-medium flex items-center gap-2 transition-colors hover:bg-primary-50 hover:text-white active:bg-primary-70 focus:outline-none focus:ring-2 focus:ring-primary-50"
              onClick={() => setIsSettingsOpen(true)}
            >
              <Icons.Setting className="size-4" />
              Notifications Settings
            </button>
          </div>
        )}
      </div>

      {/* List + detail */}
      <div className="mt-4 flex gap-4 w-full">
        {enabledTypes.length === 0 ? (
          <NoNotificationsEnabled onOpenSettings={() => setIsSettingsOpen(true)} />
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

      <ArchiveAllConfirmationDialog
        open={isArchiveDialogOpen}
        onClose={() => setIsArchiveDialogOpen(false)}
        onConfirm={handleArchiveAllConfirm}
        loading={isArchiving}
      />

      <NotificationsSettingsDialog
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </DashboardTitleWrapper>
  );
};

export default Notifications;
