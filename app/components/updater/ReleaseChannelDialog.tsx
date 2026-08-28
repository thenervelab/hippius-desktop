"use client";

import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { errorMessage as toErrorMessage } from "@/lib/utils/errorUtils";
import {
  releaseChannelStatus,
  switchReleaseChannel,
  type ChannelStatus,
} from "@/lib/tauri/updates";
import { getChannelView } from "@/app/components/updater/releaseChannelCopy";
import {
  channelDialogOpenAtom,
  closeChannelDialog,
} from "@/app/components/updater/releaseChannelStore";
import { updateStore } from "@/app/components/updater/updateStore";

/**
 * The Explore Beta / Leave Beta explainer.
 *
 * Opened from the address menu (`ProfileCard`). Downloads nothing until the
 * user confirms — the whole reason the dialog exists is that opting into
 * unreleased builds should be a decision, not a click.
 *
 * Built on the shared `ConfirmDialog` rather than a bespoke modal so it matches
 * every other confirmation in the app; the copy comes from the pure resolver in
 * `releaseChannelCopy.ts`, shared with the settings section.
 *
 * Renders nothing when closed. Mounted once beside `UpdateDialogWrapper`.
 */
export default function ReleaseChannelDialog() {
  const open = useAtomValue(channelDialogOpenAtom, { store: updateStore });
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [switching, setSwitching] = useState(false);

  // Re-read on every open: the target lane may have published since the app
  // started, and the dialog names the exact version it will install.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    releaseChannelStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // Rust never errors here on a network problem — it leaves the version
        // empty — so a rejection means the command is missing entirely. Close
        // rather than show a dialog with nothing in it.
        if (!cancelled) closeChannelDialog();
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open || !status) return null;

  const view = getChannelView(status);

  const handleConfirm = async () => {
    if (!status.target) return;

    setSwitching(true);
    const toastId = toast.loading("Downloading…", { duration: Infinity });

    try {
      await switchReleaseChannel(status.target, ({ bytesDone, bytesTotal }) => {
        // An asset served without Content-Length gives no denominator, so show
        // bytes rather than a percentage that would divide by zero.
        toast.loading(
          bytesTotal
            ? `Downloading… ${Math.min(Math.round((bytesDone / bytesTotal) * 100), 100)}%`
            : "Downloading…",
          { id: toastId, duration: Infinity },
        );
      });

      toast.dismiss(toastId);
      toast.success("Installed", {
        description: "Hippius will restart now.",
        duration: 3000,
      });
      await relaunch();
    } catch (err) {
      toast.dismiss(toastId);
      // Surfaces Rust's own message, which names the actionable condition —
      // the downgrade guard's "wait for the stable release to catch up", or an
      // unreachable channel. A generic "switch failed" would hide both.
      toast.error("Could not switch channel", {
        description: toErrorMessage(err),
        duration: 8000,
      });
      setSwitching(false);
      closeChannelDialog();
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        // Non-dismissable once the download starts: closing would leave an
        // install running with nothing on screen explaining the restart.
        if (!next && !switching) closeChannelDialog();
      }}
      variant={status.current === "beta" ? "info" : "warning"}
      title={view.title}
      description={status.blockedReason ?? view.description}
      confirmText={view.confirmText}
      cancelText="Cancel"
      isLoading={switching}
      onConfirm={handleConfirm}
    />
  );
}
