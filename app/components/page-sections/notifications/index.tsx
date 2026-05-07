"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
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
      ...(enabledTypes.length > 0 ? [{ tabName: "All", displayName: "All" }] : []),
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
                <div className="inline-flex items-center gap-1 rounded-[6px] bg-[#ebebeb] p-[3px] dark:bg-[#000000]">
                  {tabs.map((tab) => {
                    const isActive = activeTab === tab.tabName;
                    return (
                      <button
                        key={tab.tabName}
                        onClick={() => setActiveTab(tab.tabName)}
                        className={cn(
                          "flex items-center px-[6px] py-px rounded-[3px] font-mono text-[12px] font-medium leading-5 uppercase tracking-[-0.24px] whitespace-nowrap text-black dark:text-white border border-[#e3e3e3] dark:border-[#313131] bg-[#f8f8f8] dark:bg-[#1e1e1e] shadow-tab-active transition-[opacity,background-color,border-color,box-shadow]",
                          !isActive && "!bg-transparent !border-transparent !shadow-none opacity-50 hover:opacity-75",
                        )}
                      >
                        {tab.displayName ?? tab.tabName}
                      </button>
                    );
                  })}
                </div>
              )}

              {tabs.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap">
                  {/* All / Unread toggle */}
                  <div className="inline-flex items-center gap-1 rounded-[6px] border border-[#e3e3e3] bg-[#ebebeb] p-[3px] drop-shadow-[0px_1px_0px_white] dark:border-[#313131] dark:bg-[#000000] dark:drop-shadow-none">
                    {(["all", "unread"] as const).map((id) => {
                      const isActive = id === (onlyUnread ? "unread" : "all");
                      return (
                        <button
                          key={id}
                          onClick={() => setOnlyUnread(id === "unread")}
                          className={cn(
                            "flex items-center gap-[6px] px-3 h-[24px] rounded-[3px] text-[13px] font-medium leading-[1.109] tracking-[-0.26px] whitespace-nowrap text-black dark:text-white border border-[#e3e3e3] dark:border-[#313131] bg-[#f8f8f8] dark:bg-[#1e1e1e] shadow-tab-active transition-[opacity,background-color,border-color,box-shadow]",
                            !isActive && "!bg-transparent !border-transparent !shadow-none opacity-50 hover:opacity-75",
                          )}
                        >
                          <span className={`size-[7px] flex-shrink-0 rounded-full ${isActive ? "bg-[#3167dd]" : "bg-black/40 dark:bg-white/40"}`} />
                          {id === "all" ? "All" : "Unread"}
                        </button>
                      );
                    })}
                  </div>

                  {/* Mark all as read */}
                  <button
                    className="flex items-center h-[30px] px-[10px] gap-2 text-[14px] font-medium tracking-[-0.28px] rounded-[7px] bg-[#fefefe] border border-[#e3e3e3] text-[#111] shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)] hover:bg-[#f5f5f5] dark:bg-[#1e1e1e] dark:border-[#313131] dark:text-white dark:shadow-[0px_0px_0px_1px_black] dark:hover:bg-[#252525] disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                    onClick={handleAllRead}
                    disabled={visible.length === 0}
                  >
                    Mark all as read
                  </button>

                  {/* Notifications Settings */}
                  <button
                    className="flex items-center h-[30px] px-[10px] gap-2 text-[14px] font-medium tracking-[-0.28px] rounded-[7px] bg-[#fefefe] border border-[#e3e3e3] text-[#111] shadow-[0px_5px_2.3px_0px_rgba(0,0,0,0.03),0px_1px_1.9px_0px_rgba(0,0,0,0.14),0px_0px_1px_0px_rgba(0,0,0,0.16)] hover:bg-[#f5f5f5] dark:bg-[#1e1e1e] dark:border-[#313131] dark:text-white dark:shadow-[0px_0px_0px_1px_black] dark:hover:bg-[#252525] whitespace-nowrap"
                    onClick={() => setIsSettingsOpen(true)}
                  >
                    <Settings className="size-[14px]" />
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
                  <div className="w-1/2 flex-shrink-0 border-r border-grey-dark-100 dark:border-black-300 overflow-hidden">
                    <NotificationList
                      notifications={visible}
                      selectedNotificationId={selectedId}
                      onSelectNotification={onItemClick}
                      onReadStatusChange={onReadToggle}
                      onRefresh={handleRefreshNotifications}
                    />
                  </div>
                  <div className="w-1/2 flex-shrink-0 overflow-hidden">
                    {detail ? (
                      <NotificationDetailView
                        selectedNotification={detail}
                        onReadStatusChange={onReadToggle}
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
                        <p className="text-[14px] font-medium text-grey-dark-500 dark:text-grey-dark-400">
                          Select a notification to view details
                        </p>
                      </div>
                    )}
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
