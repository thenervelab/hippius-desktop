"use client";

import { useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { toast } from "sonner";
import { relaunch } from "@tauri-apps/plugin-process";
import { MonitorSmartphone } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { captureDialogAtom, capturePermissionPaneAtom } from "@/app/lib/capture/captureFlow";
import { requestScreenRecordingPermission } from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/** What macOS 13 and earlier call the pane, for a Mac whose version Rust could not name. */
const FALLBACK_PANE = "Screen Recording";

/**
 * macOS Screen Recording, explained before it is needed rather than after a
 * black screenshot. The grant only takes effect after a relaunch, which the
 * system prompt never says, so the dialog says it and offers the relaunch.
 *
 * The button asks Rust (`capture_request_permission`): macOS's own prompt
 * the first time, System Settings on the pane after that, since macOS only
 * ever prompts once. The pane is named as this Mac names it
 * (`capture_support.permissionPane`; macOS 14 renamed it).
 */
export default function CapturePermissionDialog() {
  const [dialog, setDialog] = useAtom(captureDialogAtom);
  const pane = useAtomValue(capturePermissionPaneAtom) ?? FALLBACK_PANE;
  const [prompted, setPrompted] = useState(false);
  const open = dialog?.kind === "permission";
  const close = () => {
    setPrompted(false);
    setDialog(null);
  };

  const openSettings = () => {
    requestScreenRecordingPermission()
      .then((step) => {
        if (step === "granted") close();
        else setPrompted(step === "prompted");
      })
      .catch((error) => toast.error(errorMessage(error)));
  };

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title="Allow screen recording"
      icon={<MonitorSmartphone className="size-4 text-white" />}
    >
      <div className="flex flex-col gap-5">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-grey-50 dark:text-grey-dark-600">
          <li>
            Open <span className="font-semibold">System Settings → Privacy &amp; Security → {pane}</span>.
          </li>
          <li>Switch <span className="font-semibold">Hippius</span> on.</li>
          <li>Relaunch Hippius. macOS only applies the change after a restart.</li>
        </ol>

        {prompted && (
          <p role="status" className="text-sm text-grey-50 dark:text-grey-dark-600">
            macOS is asking now. Choose Allow, then relaunch Hippius.
          </p>
        )}

        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={openSettings}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            Open System Settings
          </Button>
          <Button
            variant="primary"
            size="auto"
            onClick={() => void relaunch()}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            Relaunch Hippius
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
