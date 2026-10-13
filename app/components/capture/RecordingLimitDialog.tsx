"use client";

import { useCallback } from "react";
import { useAtom } from "jotai";
import { useRouter } from "next/navigation";
import { Video } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import { RECORDING_LIMIT_BODY, RECORDING_LIMIT_TITLE } from "@/app/lib/capture/recordingLimit";
import { BILLING_ROUTE, CAPTURES_ROUTE } from "@/app/lib/routes";

const BUTTON = "h-[44px] min-w-[8rem] flex-1 rounded-[6px] text-sm font-medium";

/**
 * A Record start refused because the free plan's recordings are used up
 * (Rust's `RECORDING_LIMIT_REACHED`, decided before anything recorded).
 * Shown in the main window for a start from the tray, a menu or the record
 * shortcut; the capture bar shows the same panel itself
 * (`capture-overlay/RecordingLimitPanel`). Upgrade goes to the plans, where
 * every upgrade prompt goes; Open Captures is where an older recording can
 * be deleted.
 */
export default function RecordingLimitDialog() {
  const [dialog, setDialog] = useAtom(captureDialogAtom);
  const router = useRouter();
  const open = dialog?.kind === "recordingLimit";
  const close = useCallback(() => setDialog(null), [setDialog]);
  const go = (route: string) => {
    close();
    router.push(route);
  };

  return (
    <FramedDialog open={open} onClose={close} title={RECORDING_LIMIT_TITLE} icon={<Video className="size-4 text-white" />}>
      <div className="flex flex-col gap-5">
        <p className="text-sm text-grey-50 dark:text-grey-dark-600">{RECORDING_LIMIT_BODY}</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="primary" size="auto" onClick={() => go(BILLING_ROUTE)} className={BUTTON}>
            Upgrade
          </Button>
          <Button variant="defaultStable" size="auto" onClick={() => go(CAPTURES_ROUTE)} className={BUTTON}>
            Open Captures
          </Button>
          <Button variant="defaultStable" size="auto" onClick={close} className={BUTTON}>
            Not now
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
