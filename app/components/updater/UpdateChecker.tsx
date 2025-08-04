/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef } from "react";
import { checkForUpdates } from "@/app/components/updater/checkForUpdates";

import { useSetAtom } from "jotai";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";

export default function UpdateChecker() {
  const didRun = useRef(false);
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);

  useEffect(() => {
    if (didRun.current) return;

    // optional: guard across full session
    if (!(window as any).__didCheckUpdates) {
      (window as any).__didCheckUpdates = true;
      checkForUpdates(true);
      refreshUnread();
    }

    didRun.current = true;
  }, []);

  return null;
}
