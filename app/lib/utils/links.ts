/* eslint-disable @typescript-eslint/no-explicit-any */

import { openUrl } from "@tauri-apps/plugin-opener";
import { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { checkForUpdates } from "../../components/updater/checkForUpdates";

// Centralized object containing all application links
export const APP_LINKS: any = {
  BILLING: "https://console.hippius.com/dashboard/billing",
  CREDITS: "http://console.hippius.com/dashboard/billing?addCredits=true",
  // Add more links as needed
};

/**
 * Opens a URL using Tauri's opener plugin
 * @param url The URL to open
 */
export const openAppLink = async (url: string): Promise<void> => {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("Failed to open URL:", error);
  }
};

/**
 * Opens a predefined application link by key
 * @param linkKey The key of the link in APP_LINKS
 */
export const openLinkByKey = async (
  linkKey: keyof typeof APP_LINKS | string
): Promise<void> => {
  await openAppLink(APP_LINKS[linkKey]);
};

/**
 * Handles button link clicks with proper routing behavior
 */
export const handleButtonLink = (
  e: React.MouseEvent,
  buttonLink: string | undefined,
  router: AppRouterInstance,
  setActiveSubMenuItem?: (item: string) => void
) => {
  if (buttonLink) {
    e.preventDefault();
    e.stopPropagation();
    if (buttonLink.includes("Install")) {
      checkForUpdates();
    } else if (buttonLink.includes("BILLING")) {
      openLinkByKey(buttonLink);
    } else {
      if (buttonLink.includes("/files") && setActiveSubMenuItem) {
        setActiveSubMenuItem("Private");
      }
      router.push(buttonLink);
    }
  }
};
