"use client";

import { useCreditsNotification } from "@/app/lib/hooks/useCreditsNotification";
import { useFilesNotification } from "@/app/lib/hooks/useFilesNotification";
import { useEffect, useState } from "react";
import { useSetAtom, useAtom } from "jotai";
import * as Menubar from "@radix-ui/react-menubar";

import {
  refreshUnreadCountAtom,
  unreadCountAtom,
} from "@/components/page-sections/notifications/notificationStore";
import NotificationIconButton from "./NotificationIconButton";
import NotificationMenuContent from "./NotificationMenuContent";

type Props = {
  className?: string;
};

export default function NotificationMenu({ className = "delay-500" }: Props) {
  useCreditsNotification();
  useFilesNotification();
  const refreshUnreadCount = useSetAtom(refreshUnreadCountAtom);
  const [count] = useAtom(unreadCountAtom);
  const [menuValue, setMenuValue] = useState<string>("");

  useEffect(() => {
    refreshUnreadCount();
  }, [refreshUnreadCount]);

  return (
    <Menubar.Root
      value={menuValue}
      onValueChange={setMenuValue} // Let Radix handle open/close
    >
      <Menubar.Menu value="notifications">
        <Menubar.Trigger asChild>
          <button>
            <NotificationIconButton className={className} count={count} />
          </button>
        </Menubar.Trigger>

        <Menubar.Portal>
          <Menubar.Content
            align="end"
            sideOffset={8}
            className="max-w-[428px] min-w-[428px] bg-white shadow-menu rounded-lg border border-grey-80 z-50"
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
