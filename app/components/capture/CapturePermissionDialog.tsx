"use client";

import { useAtom } from "jotai";
import { toast } from "sonner";
import { relaunch } from "@tauri-apps/plugin-process";
import { MonitorSmartphone } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import { openScreenRecordingSettings } from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/**
 * macOS Screen Recording, explained before it is needed rather than after a
 * black screenshot. The grant only takes effect after a relaunch, which the
 * system prompt never says, so the dialog says it and offers the relaunch.
 */
export default function CapturePermissionDialog() {
  const [dialog, setDialog] = useAtom(captureDialogAtom);
  const open = dialog?.kind === "permission";
  const close = () => setDialog(null);

  const openSettings = () => {
    openScreenRecordingSettings().catch((error) => toast.error(errorMessage(error)));
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
            Open <span className="font-semibold">System Settings → Privacy &amp; Security →
            Screen &amp; System Audio Recording</span>.
          </li>
          <li>Switch <span className="font-semibold">Hippius</span> on.</li>
          <li>Relaunch Hippius. macOS only applies the change after a restart.</li>
        </ol>

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
