"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { toast } from "sonner";
import { MonitorSmartphone } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { captureDialogAtom, capturePermissionPaneAtom } from "@/app/lib/capture/captureFlow";
import {
  getScreenRecordingPermissionStatus,
  relaunchForScreenRecording,
  requestScreenRecordingPermission,
  resetScreenRecordingPermission,
  type CapturePermissionRequest,
  type CapturePermissionStatus,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/** What macOS 13 and earlier call the pane, for a Mac whose version Rust could not name. */
const FALLBACK_PANE = "Screen Recording";

/** What the last press did, for the line under the steps. */
type Notice = "prompted" | "resetFailed" | null;

const TEXT = "text-sm text-grey-50 dark:text-grey-dark-600";
const BUTTON = "h-[44px] min-w-[10rem] flex-1 rounded-[6px] text-sm font-medium";

/**
 * macOS Screen Recording, explained before it is needed rather than after a
 * black screenshot. Rust decides everything (`capture_permission_status`):
 *
 * - not asked for this build: "Allow" asks macOS, whose prompt adds Hippius
 *   to the list switched off;
 * - asked: "Open System Settings" opens the pane (asking macOS first, which
 *   re-adds an entry that was removed since);
 * - stale: relaunched for the grant and still denied. macOS is holding an
 *   entry it will not apply to this build (a rebuilt local app, most often),
 *   so the dialog says how to clear it and "Allow again" resets Hippius's
 *   own entry and asks afresh.
 *
 * The grant only takes effect after a relaunch, which the system prompt
 * never says, so the dialog says it and relaunches through Rust
 * (`capture_relaunch_for_permission`), which remembers the relaunch so a
 * stale entry can be told apart afterwards. The pane is named as this Mac
 * names it (`capture_support.permissionPane`; macOS 14 renamed it).
 */
export default function CapturePermissionDialog() {
  const [dialog, setDialog] = useAtom(captureDialogAtom);
  const pane = useAtomValue(capturePermissionPaneAtom) ?? FALLBACK_PANE;
  const [status, setStatus] = useState<CapturePermissionStatus | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const open = dialog?.kind === "permission";

  const close = useCallback(() => {
    setNotice(null);
    setStatus(null);
    setDialog(null);
  }, [setDialog]);

  const refresh = useCallback(() => {
    getScreenRecordingPermissionStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const after = (step: CapturePermissionRequest, failedNotice: Notice) => {
    if (step === "granted") {
      close();
      return;
    }
    setNotice(step === "prompted" ? "prompted" : failedNotice);
    refresh();
  };

  const allow = () => {
    requestScreenRecordingPermission()
      .then((step) => after(step, null))
      .catch((error) => toast.error(errorMessage(error)));
  };

  const allowAgain = () => {
    resetScreenRecordingPermission()
      .then((step) => after(step, "resetFailed"))
      .catch((error) => toast.error(errorMessage(error)));
  };

  const relaunch = () => {
    relaunchForScreenRecording().catch((error) => toast.error(errorMessage(error)));
  };

  const stale = status?.state === "stale";
  const firstAsk = status?.state === "notAsked";

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title="Allow screen recording"
      icon={<MonitorSmartphone className="size-4 text-white" />}
    >
      <div className="flex flex-col gap-5">
        {stale ? (
          <div className="flex flex-col gap-2">
            <p className={TEXT}>
              Hippius still can&apos;t record the screen after relaunching. If it is already switched on, macOS is
              holding an old entry for Hippius that it won&apos;t apply.
            </p>
            <p className={TEXT}>
              In <span className="font-semibold">{pane}</span>, remove Hippius with the minus button, then press
              Allow again. Allow again can also remove it for you.
            </p>
          </div>
        ) : (
          <ol className={`flex list-decimal flex-col gap-2 pl-5 ${TEXT}`}>
            <li>
              Open <span className="font-semibold">System Settings → Privacy &amp; Security → {pane}</span>.
            </li>
            <li>
              Switch <span className="font-semibold">Hippius</span> on.
            </li>
            <li>Relaunch Hippius. macOS only applies the change after a restart.</li>
          </ol>
        )}

        {notice === "prompted" && (
          <p role="status" className={TEXT}>
            macOS is asking now. Choose Open System Settings in its message, switch Hippius on, then relaunch Hippius.
            No message? Press Open System Settings.
          </p>
        )}
        {notice === "resetFailed" && (
          <p role="status" className={TEXT}>
            Hippius couldn&apos;t remove the old entry itself. In {pane}, select Hippius, remove it with the minus
            button, then press Open System Settings here.
          </p>
        )}

        {status?.adHocSigned && (
          <p className="text-xs text-grey-60 dark:text-grey-dark-500">
            This copy of Hippius was built without a signing certificate, so macOS treats every new build as a new app
            and asks again.
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          {stale ? (
            <Button variant="defaultStable" size="auto" onClick={allowAgain} className={BUTTON}>
              Allow again
            </Button>
          ) : (
            <Button variant="defaultStable" size="auto" onClick={allow} className={BUTTON}>
              {firstAsk ? "Allow" : "Open System Settings"}
            </Button>
          )}
          <Button variant="primary" size="auto" onClick={relaunch} className={BUTTON}>
            Relaunch Hippius
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
