// The update check runs in RUST (`src-tauri/src/updates.rs`), not through
// @tauri-apps/plugin-updater's check()/downloadAndInstall(). Those read the one
// `plugins.updater.endpoints` list compiled into tauri.conf.json and the JS
// CheckOptions cannot override it, so a beta build would ask the production
// lane for updates — and with every lane sharing one signing key that manifest
// verifies and installs. This file is presentation: dialog, toasts, relaunch.
/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import {
  checkForUpdate,
  installUpdate,
  type AvailableUpdate,
} from "@/lib/tauri/updates";
import { tauriErrorDetail } from "@/lib/utils/dispatchTauriError";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { getUpdateInstallPlan } from "@/app/components/updater/updateInstallPlan";
import {
  addNotification,
  hippusVersionNotificationExists,
} from "@/lib/helpers/notificationsDb";
import { toast } from "sonner";
import {
  openUpdateDialog,
  getUpdateConfirmation,
  updateStore,
  updateConfirmedAtom,
} from "@/app/components/updater/updateStore";

/**
 * Shown only when a rejection carried no Rust-owned message — an IPC transport
 * failure, which arrives as a bare `{}`. Every error `updates.rs` returns names
 * a next step, so this generic line should be unreachable in practice; it exists
 * so a transport failure does not render as "Unknown error".
 */
export const UPDATE_FAILED_FALLBACK = "Please try again later.";

// Utility function to format bytes to MB
function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

// Utility function to format percentage
function formatPercentage(current: number, total: number): string {
  return ((current / total) * 100).toFixed(1);
}

// Store the current update for dialog access
let currentUpdateObject: AvailableUpdate | null = null;

export function getCurrentUpdate(): AvailableUpdate | null {
  return currentUpdateObject;
}

export async function checkForUpdates(notifyOnce = false) {
  let downloadToastId: string | number | undefined;

  try {
    console.log("Checking for updates...");
    const update = await checkForUpdate();
    if (!update) {
      console.log("No updates available");
      return;
    }

    console.log("Update found:", update.version);
    const version = update.version;
    const releaseNotes = update.notes;

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
      body: update.notes,
    });

    // If this is a startup check (notifyOnce = true), don't wait for user response
    // The dialog will handle the user interaction independently
    if (notifyOnce) {
      return; // Exit early, let the app continue loading
    }

    // Wait for user response via store subscription — no polling
    const userResponse = await new Promise<boolean | null>((resolve) => {
      const unsub = updateStore.sub(updateConfirmedAtom, () => {
        const value = updateStore.get(updateConfirmedAtom);
        if (value !== null) {
          unsub();
          resolve(value);
        }
      });
      // Check immediately in case it was already set
      const current = getUpdateConfirmation();
      if (current !== null) {
        unsub();
        resolve(current);
      }
    });

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
  update: AvailableUpdate,
  downloadToastId?: string | number,
) {
  const plan = getUpdateInstallPlan(update);
  if (plan.kind === "manual") {
    await openUrl(plan.url);
    return;
  }

  let totalBytes = 0;
  let started = false;

  // Rust reports CUMULATIVE bytes, unlike the JS plugin's per-chunk deltas —
  // no accumulator here, and no "Started"/"Finished" events either, so the
  // first progress message stands in for the start of the download.
  await installUpdate(({ bytesDone, bytesTotal }) => {
    totalBytes = bytesTotal ?? totalBytes;

    if (!started) {
      started = true;
      downloadToastId = toast.loading(
        totalBytes
          ? `Starting download... (${formatBytes(totalBytes)} MB)`
          : "Starting download...",
        {
          description: totalBytes
            ? "0% complete • 0 MB / " + formatBytes(totalBytes) + " MB"
            : "Preparing…",
          duration: Infinity,
        },
      );
      return;
    }

    if (!downloadToastId) return;

    // An asset served without Content-Length gives no denominator, so show
    // bytes downloaded rather than a percentage that would divide by zero.
    if (!totalBytes) {
      toast.loading("Downloading update...", {
        id: downloadToastId,
        description: `${formatBytes(bytesDone)} MB downloaded`,
        duration: Infinity,
      });
      return;
    }

    const percentage = formatPercentage(bytesDone, totalBytes);
    toast.loading(`Downloading update... ${percentage}%`, {
      id: downloadToastId,
      description: `${formatBytes(bytesDone)} MB / ${formatBytes(totalBytes)} MB • ${formatBytes(
        Math.max(totalBytes - bytesDone, 0),
      )} MB remaining`,
      duration: Infinity,
    });
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

  // `updates.rs` owns every sentence here, signature failures included — it
  // classifies the plugin's error and returns copy that already names the
  // channel's release page and how to install by hand. The substring match on
  // `err.message` this replaces was the pattern CLAUDE.md forbids: it keyed
  // user-visible behaviour off English text Rust is free to reword, and it
  // could only ever fire while raw plugin errors were being forwarded.
  toast.error("Update failed", {
    description: tauriErrorDetail(err) || UPDATE_FAILED_FALLBACK,
    duration: 8000,
  });
}

/**
 * Returns the available update if there's a newer version on this build's own
 * channel, or null if you're already up to date.
 */
export async function getAvailableUpdate(): Promise<AvailableUpdate | null> {
  try {
    return await checkForUpdate();
  } catch {
    return null;
  }
}

/**
 * Start the update process for a given update
 */
export async function startUpdateProcess(update?: AvailableUpdate) {
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
