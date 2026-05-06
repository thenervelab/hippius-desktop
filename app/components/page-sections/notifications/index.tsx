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
      ...(enabledTypes.length > 0 ? [{ tabName: "All" }] : []),
      ...enabledTypes.map((type) => ({ tabName: type })),
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
      {/*
        Figma outer card: Frame 2147237449
        fill=#fbfbfb, radius=11, paddingTop/Bottom=12, gap=12
      */}
      <div className="mt-4 flex flex-col rounded-[11px] pb-3 gap-3" style={{ backgroundColor: "#fbfbfb" }}>

        {/* ── Header row ────────────────────────────────────────────────────
            Figma: Frame 2147229289
            border-b #e3e3e3, gap=14, paddingLeft/Right=12
        */}
        <div
          className="flex items-center justify-between gap-3.5 border-b px-3 pt-3 pb-3 flex-wrap"
          style={{ borderColor: "#e3e3e3" }}
        >
          <div className="flex flex-col gap-0.5">
            {/* Figma: Geist w500 24px, lh=32px, #0a0a0a */}
            <h1
              className="text-[24px] font-medium leading-[32px]"
              style={{ color: "#0a0a0a" }}
            >
              Notifications Hub
            </h1>
            {/* Figma: Geist w500 16px, lh=22px, ls=-0.32, #7d7d7d */}
            <p
              className="text-[16px] font-medium leading-[22px]"
              style={{ color: "#7d7d7d", letterSpacing: "-0.32px" }}
            >
              Store. Compute. Own your infrastructure.
            </p>
          </div>
          <NotificationHubStats />
        </div>

        {/* ── Content area ──────────────────────────────────────────────────
            Figma: Frame 2147237607, paddingLeft/Right=12
        */}
        <div className="px-3">
          {/*
            Figma: "Line Chart" frame
            fill=#f8f8f8, stroke=#e3e3e3, radius=8
          */}
          <div
            className="border rounded-lg overflow-hidden flex flex-col"
            style={{ backgroundColor: "#f8f8f8", borderColor: "#e3e3e3" }}
          >
            {/* ── Tabs row ──────────────────────────────────────────────────
                Figma: Frame 2147237398
                border-b #e3e3e3, gap=10, padding L/R=10 T/B=8
            */}
            <div
              className="flex items-center justify-between border-b px-2.5 py-2 gap-2.5 flex-wrap"
              style={{ borderColor: "#e3e3e3" }}
            >
              {/* Left: type filter pill tabs
                  Figma: fill=#eaeaea, radius=6, padding=3, gap=4
                  Each tab: fill=#f8f8f8, stroke=#e3e3e3, radius=3, px=6, py=3
                  Font: Geist Mono w500 12px ls=-0.24
              */}
              {tabs.length > 0 && (
                <div
                  className="flex items-center gap-1 rounded-md p-[3px]"
                  style={{ backgroundColor: "#eaeaea" }}
                >
                  {tabs.map((tab) => (
                    <button
                      key={tab.tabName}
                      onClick={() => setActiveTab(tab.tabName)}
                      className={cn(
                        "px-1.5 py-0.5 rounded-[3px] text-[12px] font-mono font-medium transition-colors",
                        activeTab === tab.tabName
                          ? "bg-white border border-[#e3e3e3]"
                          : "bg-transparent border border-transparent hover:bg-white/60"
                      )}
                      style={{ color: "#0a0a0a", letterSpacing: "-0.24px" }}
                    >
                      {tab.tabName}
                    </button>
                  ))}
                </div>
              )}

              {/* Right: All/Unread toggle + action buttons */}
              {tabs.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap">
                  {/* All / Unread pill
                      Figma: outer fill=#eaeaea, stroke=#e3e3e3, radius=6, padding=4
                      Each button: fill=#f8f8f8, stroke=#e3e3e3, radius=3, px=12, py=5
                      Font: Geist w500 13px ls=-0.26
                  */}
                  <div
                    className="flex items-center border rounded-md p-1 gap-1"
                    style={{ backgroundColor: "#eaeaea", borderColor: "#e3e3e3" }}
                  >
                    <button
                      onClick={() => setOnlyUnread(false)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-[5px] rounded-[3px] text-[13px] font-medium transition-colors",
                        !onlyUnread
                          ? "bg-[#f8f8f8] border border-[#e3e3e3]"
                          : "bg-transparent border border-transparent hover:bg-white/60"
                      )}
                      style={{ color: "#000000", letterSpacing: "-0.26px" }}
                    >
                      <span className="size-2 rounded-full bg-[#3067dd] flex-shrink-0" />
                      All
                    </button>
                    <button
                      onClick={() => setOnlyUnread(true)}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-[5px] rounded-[3px] text-[13px] font-medium transition-colors",
                        onlyUnread
                          ? "bg-[#f8f8f8] border border-[#e3e3e3]"
                          : "bg-transparent border border-transparent hover:bg-white/60"
                      )}
                      style={{ color: "#1e1e1e", letterSpacing: "-0.26px" }}
                    >
                      <span className="size-2 rounded-full bg-[#1e1e1e] flex-shrink-0" />
                      Unread
                    </button>
                  </div>

                  {/* Mark all as read
                      Figma: fill=#fefefe, stroke=#e3e3e3, radius=6, px=12, py=8
                      Font: Geist w500 14px ls=-0.28 #111111
                  */}
                  <button
                    className="flex items-center gap-1.5 px-3 py-2 rounded-md border text-[14px] font-medium transition-colors hover:bg-[#f5f5f5] disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: "#fefefe",
                      borderColor: "#e3e3e3",
                      color: "#111111",
                      letterSpacing: "-0.28px",
                    }}
                    onClick={handleAllRead}
                    disabled={visible.length === 0}
                  >
                    Mark all as read
                  </button>

                  {/* Notifications Settings
                      Figma: same style as Mark all as read
                  */}
                  <button
                    className="flex items-center gap-1.5 px-3 py-2 rounded-md border text-[14px] font-medium transition-colors hover:bg-[#f5f5f5]"
                    style={{
                      backgroundColor: "#fefefe",
                      borderColor: "#e3e3e3",
                      color: "#111111",
                      letterSpacing: "-0.28px",
                    }}
                    onClick={() => setIsSettingsOpen(true)}
                  >
                    <Settings className="size-4" />
                    Notifications Settings
                  </button>
                </div>
              )}
            </div>

            {/* ── Notification list + detail panel ───────────────────────────
                Figma: Frame 2147229228
                fill=#ffffff, stroke=#e3e3e3, radius=8
                Left table (border-r) + Right table
            */}
            <div
              className="flex bg-white rounded-b-lg overflow-hidden"
              style={{ height: "calc(100vh - 16rem)" }}
            >
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
                  {/* Left: notification list — Figma: ~50% width, border-r #e3e3e3 */}
                  <div
                    className="w-[38%] flex-shrink-0 border-r overflow-hidden"
                    style={{ borderColor: "#e3e3e3" }}
                  >
                    <NotificationList
                      notifications={visible}
                      selectedNotificationId={selectedId}
                      onSelectNotification={onItemClick}
                      onReadStatusChange={onReadToggle}
                      onRefresh={handleRefreshNotifications}
                    />
                  </div>

                  {/* Right: detail view */}
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
