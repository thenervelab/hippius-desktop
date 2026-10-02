"use client";

import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { toast } from "sonner";
import { Camera } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import SyncFolderSelect from "@/components/ui/SyncFolderSelect";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import { useStartCapture } from "@/app/lib/capture/useStartCapture";
import {
  getCaptureDestination,
  setCaptureDestination,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/**
 * Choose which drive screenshots and recordings are filed in. Opens on the
 * first capture (and resumes it once a drive is chosen), and from the Capture
 * menu to change it.
 */
export default function CaptureDestinationDialog() {
  const [dialog, setDialog] = useAtom(captureDialogAtom);
  const open = dialog?.kind === "destination";
  const resume = open ? dialog.resume : null;
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startCapture = useStartCapture();

  useEffect(() => {
    if (!open) return;
    getCaptureDestination()
      .then((d) => setLabel(d?.label ?? null))
      .catch(() => setLabel(null));
  }, [open]);

  const close = () => setDialog(null);

  const save = async () => {
    if (!label) return;
    setBusy(true);
    try {
      await setCaptureDestination({ label, displayName: label });
      setDialog(null);
      if (resume) {
        void startCapture(resume.kind, resume.mode);
      } else {
        toast.success(`Captures will be saved to ${label}`);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title="Where should captures go?"
      icon={<Camera className="size-4 text-white" />}
    >
      <div className="flex flex-col gap-5">
        <p className="text-sm text-grey-50 dark:text-grey-dark-600">
          Screenshots and recordings are saved to a{" "}
          <span className="font-semibold">Captures</span> folder in this drive,
          and a share link is copied so you can paste it straight away.
        </p>

        <SyncFolderSelect
          label="Drive"
          includeRemote
          value={label}
          onChange={(picked) => setLabel(picked)}
        />

        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={close}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="auto"
            loading={busy}
            disabled={!label}
            onClick={() => void save()}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            {resume ? "Save and capture" : "Save"}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
