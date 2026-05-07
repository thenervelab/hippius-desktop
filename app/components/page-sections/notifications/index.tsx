"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Settings } from "lucide-react";
import DashboardTitleWrapper from "@/components/dashboard-title-wrapper";
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
import { cn } from "@/app/lib/utils";
import TabList from "@/components/ui/tabs/TabList";
import PageHeader from "@/components/ui/page-header";

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

  const CATEGORY_DISPLAY: Record<string, string> = {
    Files: "Storage",
  };

  const tabs = useMemo(
    () => [
      ...(enabledTypes.length > 0 ? [{ tabName: "All" }] : []),
      ...enabledTypes.map((type) => ({
        tabName: type,
        displayName: CATEGORY_DISPLAY[type] ?? type,
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
    markRead(id).then(() => { refreshUnread(); });
    const params = new URLSearchParams(searchParams.toString());
    params.delete("selected");
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  }, [searchParams, markRead, refreshUnread]);

  const items: UiNotification[] = notifications.map((n) => ({
    ...n,
    icon: iconMap[n.type] ?? (() => null),
  }));

  const visible = items
    .filter((n) => activeTab === "All" || n.type === activeTab)
    .filter((n) => !onlyUnread || n.unread);

  const onReadToggle = async (id: number, unread: boolean) => {
    if (unread) await markUnread(id);
    else await markRead(id);
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
    if (!userAddress) { setIsArchiveDialogOpen(false); return; }
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

  const handleRefreshNotifications = useCallback(() => { refresh(); }, [refresh]);

  return (
    <DashboardTitleWrapper mainText="Notifications">
      <div className="mb-1 mr-1 flex flex-1 flex-col rounded-[11px] pb-3 bg-[#fbfbfb] dark:bg-black-primary-bg">

        <PageHeader
          title="Notifications Hub"
          subtitle="Store. Compute. Own your infrastructure."
        />

        <div className="px-3 flex-1 flex flex-col min-h-0">
          <div className="border border-grey-dark-100 dark:border-black-300 rounded-lg overflow-hidden flex flex-col flex-1 bg-[#f8f8f8] dark:bg-black-400">

            {/* Tabs + filter row */}
            <div className="flex items-center justify-between border-b border-grey-dark-100 dark:border-black-300 px-2.5 py-2 gap-2.5 flex-wrap">
              {tabs.length > 0 && (
                <TabList
                  tabs={tabs}
                  activeTab={activeTab}
                  onTabChange={setActiveTab}
                  width="w-auto"
                  height="h-[32px]"
                />
              )}

              {tabs.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap">
                  {/* All / Unread toggle */}
                  <div className="flex items-center border border-grey-dark-100 dark:border-black-300 rounded-md p-1 gap-1 bg-[#eaeaea] dark:bg-black-300">
                    <button
                      onClick={() => setOnlyUnread(false)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-[5px] rounded-[3px] text-[13px] font-medium tracking-[-0.26px] transition-colors text-[#000000] dark:text-white",
                        !onlyUnread
                          ? "bg-[#f8f8f8] dark:bg-black-200 border border-grey-dark-100 dark:border-black-100"
                          : "bg-transparent border border-transparent hover:bg-white/30 dark:hover:bg-black-200/50"
                      )}
                    >
                      <span className={cn("size-2 rounded-full flex-shrink-0", !onlyUnread ? "bg-[#3167dd]" : "bg-[#a3a3a3]")} />
                      All
                    </button>
                    <button
                      onClick={() => setOnlyUnread(true)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-[5px] rounded-[3px] text-[13px] font-medium tracking-[-0.26px] transition-colors text-[#1e1e1e] dark:text-white",
                        onlyUnread
                          ? "bg-[#f8f8f8] dark:bg-black-200 border border-grey-dark-100 dark:border-black-100"
                          : "bg-transparent border border-transparent hover:bg-white/30 dark:hover:bg-black-200/50"
                      )}
                    >
                      <span className={cn("size-2 rounded-full flex-shrink-0", onlyUnread ? "bg-[#3167dd]" : "bg-[#a3a3a3]")} />
                      Unread
                    </button>
                  </div>

                  {/* Mark all as read */}
                  <button
                    className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-grey-dark-100 dark:border-black-300 text-[14px] font-medium tracking-[-0.28px] transition-colors bg-[#fefefe] dark:bg-black-300 text-[#111111] dark:text-white hover:bg-[#f5f5f5] dark:hover:bg-black-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    onClick={handleAllRead}
                    disabled={visible.length === 0}
                  >
                    Mark all as read
                  </button>

                  {/* Notifications Settings */}
                  <button
                    className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-grey-dark-100 dark:border-black-300 text-[14px] font-medium tracking-[-0.28px] transition-colors bg-[#fefefe] dark:bg-black-300 text-[#111111] dark:text-white hover:bg-[#f5f5f5] dark:hover:bg-black-200"
                    onClick={() => setIsSettingsOpen(true)}
                  >
                    <Settings className="size-4" />
                    Notifications Settings
                  </button>
                </div>
              )}
            </div>

            {/* Notification list + detail panel */}
            <div className="flex flex-1 bg-white dark:bg-black-500 rounded-b-lg overflow-hidden">
              {enabledTypes.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <NoNotificationsEnabled onOpenSettings={() => setIsSettingsOpen(true)} />
                </div>
              ) : visible.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <NoNotificationsFound />
                </div>
              ) : (
                <>
                  <div className="w-[38%] flex-shrink-0 border-r border-grey-dark-100 dark:border-black-300 overflow-hidden">
                    <NotificationList
                      notifications={visible}
                      selectedNotificationId={selectedId}
                      onSelectNotification={onItemClick}
                      onReadStatusChange={onReadToggle}
                      onRefresh={handleRefreshNotifications}
                    />
                  </div>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <NotificationDetailView
                      selectedNotification={detail}
                      onReadStatusChange={onReadToggle}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
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
