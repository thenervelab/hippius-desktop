/* eslint-disable @typescript-eslint/no-explicit-any */

import { openUrl } from "@tauri-apps/plugin-opener";

// Centralized object containing all application links
export const APP_LINKS: any = {
  BILLING: "https://console.hippius.com/dashboard/billing",
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
