"use client";

import { useCreditsNotification } from "@/app/lib/hooks/useCreditsNotification";
import { useFilesNotification } from "@/app/lib/hooks/useFilesNotification";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAtom, useSetAtom } from "jotai";
import * as Menubar from "@radix-ui/react-menubar";
import { toast } from "sonner";

import {
  unreadCountAtom,
  refreshUnreadCountAtom,
} from "@/components/page-sections/notifications/notificationStore";
import NotificationIconButton from "./NotificationIconButton";
import NotificationMenuContent from "./NotificationMenuContent";
import { useNotificationPreferences } from "@/app/lib/hooks/useNotificationPreferences";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { deleteAllNotifications } from "@/app/lib/helpers/notificationsDb";
import ArchiveAllConfirmationDialog from "@/components/page-sections/notifications/ArchiveAllConfirmationDialog";

type Props = {
  className?: string;
};

export default function NotificationMenu({ className = "delay-500" }: Props) {
  useCreditsNotification();
  useNotificationPreferences();
  useFilesNotification();
  // useNotifications refreshes notifications on mount (Rust scopes the read to
  // the session account), ensuring the unread count is available immediately.
  const { refresh } = useNotifications();
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  const [count] = useAtom(unreadCountAtom);
  const [menuValue, setMenuValue] = useState<string>("");
  // Delete-all confirmation. Owned here — NOT inside the dropdown content —
  // because opening a modal steals focus and closes the menu, which would
  // unmount a dialog rendered within it.
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  // Open this dropdown when the tray popover's bell is clicked. The popover is
  // a separate webview, so it focuses this window and emits the event rather
  // than rendering the notifications portal itself (which would duplicate the
  // notification-generator hooks above). See `app/tray-panel/page.tsx`.
  useEffect(() => {
    const unlisten = listen("hippius:tray-open-notifications", () => {
      setMenuValue("notifications");
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Same flow as the notifications page's "Clear all" — confirm, delete all
  // rows for the session account in Rust, then refresh the shared list and
  // the unread badge.
  const handleClearAllConfirm = async () => {
    setIsClearing(true);
    try {
      await deleteAllNotifications();
      await refresh();
      await refreshUnread();
      toast.success("All notifications deleted");
    } catch (error) {
      console.log("Delete all notifications error:", error);
      toast.error("Failed to delete notifications");
    } finally {
      setIsClearing(false);
      setIsClearDialogOpen(false);
    }
  };

  return (
    <>
      <Menubar.Root
        className="h-full flex items-center"
        value={menuValue}
        onValueChange={setMenuValue}
      >
        <Menubar.Menu value="notifications">
          <Menubar.Trigger asChild>
            <NotificationIconButton className={className} count={count} />
          </Menubar.Trigger>

          <Menubar.Portal>
            <Menubar.Content
              align="end"
              sideOffset={8}
              className="max-w-[26.75rem] min-w-[26.75rem] bg-white dark:bg-black-500 shadow-[0px_4px_24px_0px_rgba(0,0,0,0.15)] dark:shadow-[0_12px_36px_rgba(0,0,0,0.5)] rounded-lg border border-grey-dark-100 dark:border-black-300 z-50 max-h-[calc(100vh-5rem)] flex flex-col overflow-hidden"
            >
              <NotificationMenuContent
                count={count}
                onClose={() => setMenuValue("")} // Close by clearing value
                onRequestClearAll={() => {
                  setMenuValue("");
                  setIsClearDialogOpen(true);
                }}
              />
            </Menubar.Content>
          </Menubar.Portal>
        </Menubar.Menu>
      </Menubar.Root>

      <ArchiveAllConfirmationDialog
        open={isClearDialogOpen}
        onClose={() => setIsClearDialogOpen(false)}
        onConfirm={handleClearAllConfirm}
        loading={isClearing}
      />
    </>
  );
}
