/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  addNotification,
  hippusVersionNotificationExists
} from "../../helpers/notificationsDb";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { useSetAtom } from "jotai";
import { refreshUnreadCountAtom } from "@/components/page-sections/notifications/notificationStore";

// Utility function to format bytes to MB
function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

// Utility function to format percentage
function formatPercentage(current: number, total: number): string {
  return ((current / total) * 100).toFixed(1);
}

export async function checkForUpdates(notifyOnce = false) {
  const refreshUnread = useSetAtom(refreshUnreadCountAtom);
  let downloadToastId: string | number | undefined;

  try {
    const update = await check();
    if (!update) return;

    const version = update.version;

    // Optional in-app notification
    const notified = await hippusVersionNotificationExists(version);
    if (!notified) {
      await addNotification({
        notificationType: "Hippius",
        notificationSubtype: version,
        notificationTitleText: "Update Available",
        notificationDescription: `Hippius ${version} is ready. Install and restart now.`,
        notificationLinkText: "Install Update",
        notificationLink: "Install Update"
      });
      await refreshUnread();
    }

    if (notifyOnce && notified) return;

    // Prompt user
    const install = await ask(
      `Version ${update.version} is ready to install!\n\nRelease notes: ${update.body}`,
      {
        title: "Update Available",
        kind: "info",
        okLabel: "Update",
        cancelLabel: "Cancel"
      }
    );

    if (!install) return;

    let totalBytes = 0;
    let downloadedBytes = 0;

    // Download, install, then relaunch
    await update.downloadAndInstall((e) => {
      switch (e.event) {
        case "Started":
          totalBytes = e.data.contentLength ?? 0;
          console.log(`Downloading ${formatBytes(totalBytes)} MB…`);

          // Show initial download toast
          downloadToastId = toast.loading(
            `Starting download... (${formatBytes(totalBytes)} MB)`,
            {
              description:
                "0% complete • 0 MB / " + formatBytes(totalBytes) + " MB",
              duration: Infinity
            }
          );
          break;

        case "Progress":
          downloadedBytes += e.data.chunkLength;
          const percentage = formatPercentage(downloadedBytes, totalBytes);
          const downloadedMB = formatBytes(downloadedBytes);
          const totalMB = formatBytes(totalBytes);
          const remainingMB = formatBytes(totalBytes - downloadedBytes);

          // Update the existing toast with progress
          if (downloadToastId) {
            toast.loading(`Downloading update... ${percentage}%`, {
              id: downloadToastId,
              description: `${downloadedMB} MB / ${totalMB} MB • ${remainingMB} MB remaining`,
              duration: Infinity
            });
          }
          break;

        case "Finished":
          // Dismiss the download progress toast and show completion
          if (downloadToastId) {
            toast.dismiss(downloadToastId);
          }

          toast.success("Download completed!", {
            description: `${formatBytes(
              totalBytes
            )} MB downloaded successfully`,
            duration: 3000
          });

          // Show installation progress
          toast.loading("Installing update...", {
            description: "Please wait while the update is being installed",
            duration: Infinity
          });
          break;
      }
    });

    // Dismiss any remaining toasts
    toast.dismiss();

    await message("Update installed. Restarting now…", { title: "Success" });

    // Show final success toast before relaunch
    toast.success("Update installed successfully!", {
      description: "Application will restart now...",
      duration: 2000
    });

    await relaunch();
  } catch (err) {
    // Dismiss any progress toasts on error
    if (downloadToastId) {
      toast.dismiss(downloadToastId);
    }

    console.error("[Updater] failed:", err);

    toast.error("Update failed", {
      description: "Please try again later",
      duration: 5000
    });

    await message("Update failed. Please try again later.", { title: "Error" });
  }
}

/**
 * Returns the Update object if there's a newer version,
 * or null if you're already up to date.
 */
export async function getAvailableUpdate(): Promise<Update | null> {
  try {
    const update = await check();
    return update ?? null;
  } catch {
    return null;
  }
}
