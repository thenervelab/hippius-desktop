/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef } from "react";
import { checkForUpdates } from "@/app/lib/utils/updater/checkForUpdates";

export default function UpdateChecker() {
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;

    // optional: guard across full session
    if (!(window as any).__didCheckUpdates) {
      (window as any).__didCheckUpdates = true;
      checkForUpdates(true);
    }

    didRun.current = true;
  }, []);

  return null;
}
