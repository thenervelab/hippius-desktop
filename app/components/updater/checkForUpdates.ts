/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  addNotification,
  hippusVersionNotificationExists,
} from "@/lib/helpers/notificationsDb";
import { toast } from "sonner";
import {
  openUpdateDialog,
  getUpdateConfirmation,
} from "@/app/components/updater/updateStore";

// Utility function to format bytes to MB
function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

// Utility function to format percentage
function formatPercentage(current: number, total: number): string {
  return ((current / total) * 100).toFixed(1);
}

// Store the current update object for dialog access
let currentUpdateObject: Update | null = null;

export function getCurrentUpdate(): Update | null {
  return currentUpdateObject;
}

export async function checkForUpdates(notifyOnce = false) {
  let downloadToastId: string | number | undefined;

  try {
    console.log("Checking for updates...");
    const update = await check();
    if (!update) {
      console.log("No updates available");
      return;
    }

    console.log("Update found:", update.version);
    const version = update.version;
    const releaseNotes = update.body || "";

    // Optional in-app notification
    const notified = await hippusVersionNotificationExists(version);
    if (!notified) {
      await addNotification({
        userAddress: "system",
        notificationType: "Hippius",
        notificationSubtype: version,
        notificationTitleText: "Update Available",
        notificationDescription: `Hippius ${version} is ready. Install and restart now.`,
        notificationLinkText: "Install Update",
        notificationLink: "Install Update",
        notificationReleaseNotes: releaseNotes,
      });
    }

    // Always show the dialog if an update is available, regardless of notification status
    // Only skip if notifyOnce is true AND this is just a notification check (not user-initiated)
    if (notifyOnce && notified) {
      // We've already notified about this version, but still show dialog
      console.log("Update available but already notified");
    }

    // Store the update object for dialog access
    currentUpdateObject = update;
    console.log("Opening update dialog for version:", update.version);

    // Open the update dialog with the update info
    openUpdateDialog({
      version: update.version,
      body: update.body || "",
    });

    // If this is a startup check (notifyOnce = true), don't wait for user response
    // The dialog will handle the user interaction independently
    if (notifyOnce) {
      return; // Exit early, let the app continue loading
    }

    // Wait for user response (polling) - only for manual update checks
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

    await performUpdate(update, downloadToastId);
  } catch (err) {
    handleUpdateError(err, downloadToastId);
  }
}

// Separate function to handle the actual update process
async function performUpdate(
  update: Update,
  downloadToastId?: string | number,
) {
  let totalBytes = 0;
  let downloadedBytes = 0;

  // Download, install, then relaunch with enhanced error handling
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
          },
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
          description: `${formatBytes(totalBytes)} MB downloaded successfully`,
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
}

// Separate function to handle update errors
function handleUpdateError(err: any, downloadToastId?: string | number) {
  // Dismiss any progress toasts on error
  if (downloadToastId) {
    toast.dismiss(downloadToastId);
  }

  console.log("Error in updating:", err);

  // Handle signature verification errors specifically
  const errorMessage = err instanceof Error ? err.message : String(err);
  if (
    errorMessage.includes("signature") ||
    errorMessage.includes("verification")
  ) {
    toast.error("Update signature verification failed", {
      description:
        "Please download the latest version manually from our website.",
      duration: 8000,
    });
  } else {
    toast.error("Update failed", {
      description: "Please try again later or download manually.",
      duration: 5000,
    });
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

/**
 * Start the update process for a given Update object
 */
export async function startUpdateProcess(update?: Update) {
  const updateToUse = update || currentUpdateObject;
  if (!updateToUse) {
    console.error("No update object available");
    return;
  }

  try {
    await performUpdate(updateToUse);
  } catch (err) {
    handleUpdateError(err);
  }
}
