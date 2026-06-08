"use client";

import { useCreditsNotification } from "@/app/lib/hooks/useCreditsNotification";
import { useFilesNotification } from "@/app/lib/hooks/useFilesNotification";
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAtom } from "jotai";
import * as Menubar from "@radix-ui/react-menubar";

import { unreadCountAtom } from "@/components/page-sections/notifications/notificationStore";
import NotificationIconButton from "./NotificationIconButton";
import NotificationMenuContent from "./NotificationMenuContent";
import { useNotificationPreferences } from "@/app/lib/hooks/useNotificationPreferences";
import { useNotifications } from "@/lib/hooks/useNotifications";

type Props = {
  className?: string;
};

export default function NotificationMenu({ className = "delay-500" }: Props) {
  useCreditsNotification();
  useNotificationPreferences();
  useFilesNotification();
  // useNotifications sets userAddressAtom and refreshes notifications on mount,
  // ensuring unread count is available immediately when page loads
  useNotifications();
  const [count] = useAtom(unreadCountAtom);
  const [menuValue, setMenuValue] = useState<string>("");

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

  return (
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
            />
          </Menubar.Content>
        </Menubar.Portal>
      </Menubar.Menu>
    </Menubar.Root>
  );
}
