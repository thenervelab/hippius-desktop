"use client";

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import {
  updateAlreadyNotified,
  addUpdateAvailableNotification
} from "@/app/lib/helpers/notificationsDb";

export async function checkForUpdatesOnce() {
  try {
    const update = await check();
    if (!update) return;
    toast.success(
      `Update available: ${update.version} ${update.currentVersion} ${update.rid}`
    );
    const version = update.version;

    // De-dupe using subtype = version
    const already = await updateAlreadyNotified(version);
    if (!already) {
      await addUpdateAvailableNotification({
        version: "0.8.2",
        currentVersion: "0.8.1",
        releaseNotesUrl: "https://example.com/hippius/0.8.2-notes",
        downloadPageUrl: "https://example.com/hippius/downloads"
      });
    }

    // Toast with Install action
    toast(`Hippius ${version} is available`, {
      description: "Install and restart now?",
      action: {
        label: "Install",
        onClick: async () => {
          try {
            await update.downloadAndInstall((e) => {
              // No notification for progress. Log only.
              if (e.event === "Progress") console.log(e);
            });
            await relaunch();
          } catch (err) {
            console.error("[Updater] install failed:", err);
            toast.error("Update failed. Try again later.");
          }
        }
      }
    });
  } catch (err) {
    console.error("[Updater] check failed:", err);
  }
}
