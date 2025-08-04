/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  addNotification,
  hippusVersionNotificationExists,
} from "../../helpers/notificationsDb";
import { toast } from "sonner";
import {
  openUpdateDialog,
  getUpdateConfirmation,
} from "@/lib/stores/updateStore";

// Utility function to format bytes to MB
function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

// Utility function to format percentage
function formatPercentage(current: number, total: number): string {
  return ((current / total) * 100).toFixed(1);
}

export async function checkForUpdates(notifyOnce = false) {
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
        notificationLink: "Install Update",
      });
    }

    if (notifyOnce && notified) return;

    // Open the update dialog with the update info
    openUpdateDialog({
      version: update.version,
      body: update.body || "",
    });

    // Wait for user response (polling) - will wait indefinitely
    let userResponse = null;
    while (userResponse === null) {
      userResponse = getUpdateConfirmation();
      if (userResponse === null) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // If user canceled or dialog was closed
    if (userResponse !== true) {
      return;
    }

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
              duration: Infinity,
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
              duration: Infinity,
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
            duration: 3000,
          });

          // Show installation progress
          toast.loading("Installing update...", {
            description: "Please wait while the update is being installed",
            duration: Infinity,
          });
          break;
      }
    });

    // Dismiss any remaining toasts
    toast.dismiss();

    // Show final success toast before relaunch
    toast.success("Update installed successfully!", {
      description: "Application will restart now...",
      duration: 3000,
    });

    await relaunch();
  } catch (err) {
    // Dismiss any progress toasts on error
    if (downloadToastId) {
      toast.dismiss(downloadToastId);
    }
    toast.error("Update failed", {
      description: "An error occurred while checking for updates",
      duration: 5000,
    });
    console.log(err);
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
