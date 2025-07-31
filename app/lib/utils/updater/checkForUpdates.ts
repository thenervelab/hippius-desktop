/* eslint-disable @typescript-eslint/no-explicit-any */
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
        version: version,
        currentVersion: update.currentVersion,
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
            let downloaded = 0;
            let contentLength: any = 0;
            // alternatively we could also call update.download() and update.install() separately
            await update.downloadAndInstall((event) => {
              switch (event.event) {
                case "Started":
                  contentLength = event?.data?.contentLength;
                  console.log(
                    `started downloading ${event.data.contentLength} bytes`
                  );
                  break;
                case "Progress":
                  downloaded += event.data.chunkLength;
                  toast.loading(
                    `downloaded ${downloaded} from ${contentLength}`
                  );
                  break;
                case "Finished":
                  console.log("download finished");
                  break;
              }
            });

            console.log("update installed");
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
