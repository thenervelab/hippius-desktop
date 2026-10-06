"use client";

import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { toast } from "sonner";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import { Camera, FolderOpen, Info } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { captureDialogAtom } from "@/app/lib/capture/captureFlow";
import {
  createCaptureDrive,
  getCaptureDriveLocation,
  getCaptureDriveStatus,
  type CaptureDriveLocation,
  type CaptureDriveStatus,
} from "@/app/lib/tauri/capture";
import { errorMessage } from "@/app/lib/utils/errorUtils";

const TEXT = "text-sm text-grey-50 dark:text-grey-dark-600";
const BUTTON = "h-[44px] min-w-[9rem] flex-1 rounded-[6px] text-sm font-medium";

/** The folder shown in the dialog: the one picked, else Rust's for the state. */
export function shownLocation(
  status: CaptureDriveStatus | null,
  picked: CaptureDriveLocation | null,
): CaptureDriveLocation | null {
  if (picked) return picked;
  if (!status) return null;
  if (status.state === "needsSetup") return status.suggested;
  if (status.state === "pending") return status.location;
  return status.location ?? null;
}

/**
 * Where screenshots and recordings are kept: a drive of their own, made of a
 * `Hippius Captures` folder (in Documents unless the user chooses another
 * place). Opens on its own when a capture is waiting for an answer (Rust's
 * `capture_drive_setup_needed`: the capture is safe on this computer
 * meanwhile, and stays there if the user says Not now), and from Settings,
 * the Captures page and the Capture menus to move it. Every decision (where,
 * whether a folder can be used, what macOS will ask) is Rust's; this draws it.
 */
export default function CaptureDriveDialog() {
  const [dialog, setDialog] = useAtom(captureDialogAtom);
  const open = dialog?.kind === "captureDrive";
  const [status, setStatus] = useState<CaptureDriveStatus | null>(null);
  const [picked, setPicked] = useState<CaptureDriveLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setError(null);
    setStatus(null);
    getCaptureDriveStatus()
      .then(setStatus)
      .catch((e) => setError(errorMessage(e)));
  }, [open]);

  const ready = status?.state === "ready";
  const waiting = status?.state === "needsSetup" ? status.waiting : 0;
  const location = shownLocation(status, picked);

  const close = () => {
    setDialog(null);
    // Not now, with a capture waiting: it is kept, and the user is told so.
    if (waiting > 0) {
      toast.info("Your capture is kept on this computer. Set up your Captures folder from the Captures page to upload it.");
    }
  };

  const choose = async () => {
    setError(null);
    const folder = await openFolderPicker({
      directory: true,
      multiple: false,
      title: "Choose where to keep your captures",
    }).catch(() => null);
    if (typeof folder !== "string") return;
    try {
      setPicked(await getCaptureDriveLocation(folder));
    } catch (e) {
      // Rust's sentence: inside another drive, say.
      setError(errorMessage(e));
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await createCaptureDrive(picked?.path ?? (status?.state === "pending" ? status.location.path : null));
      setDialog(null);
      if (next.state === "pending") {
        toast.warning(next.message);
      } else if (next.state === "ready") {
        toast.success(
          next.location ? `Captures are saved in ${next.location.place}.` : `Captures are saved in ${next.name}.`,
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const title = ready ? "Move your captures folder" : "A folder for your captures";
  const primary = ready ? "Use this folder" : status?.state === "pending" && !picked ? "Try again" : "Create folder";

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title={title}
      icon={<Camera className="size-4 text-white" />}
      // Wider than the default 560: the folder path and the permission note
      // read cramped at that width. Phones still get the full width.
      maxWidth="max-w-[640px]"
    >
      <div className="flex flex-col gap-5">
        {ready ? (
          <p className={TEXT}>
            New screenshots and recordings go to a Hippius Captures folder in the place you choose. Captures you already
            took stay where they are.
          </p>
        ) : (
          <p className={TEXT}>
            Hippius keeps your screenshots and recordings in a folder of their own and backs it up as a drive, so each
            capture gets a link you can share.
            {waiting > 0 && (
              <>
                {" "}
                {waiting === 1
                  ? "The capture you just took is safe on this computer and uploads as soon as the folder is ready."
                  : `${waiting} captures are safe on this computer and upload as soon as the folder is ready.`}
              </>
            )}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-xs text-grey-40 dark:text-grey-dark-600">
            {ready && !picked ? "Saved in" : "Folder"}
          </span>
          <div
            data-testid="capture-drive-location"
            className="flex min-w-0 items-center gap-3 rounded-[8px] border border-grey-dark-100 bg-white px-3 py-2.5 dark:border-black-300 dark:bg-black-600"
          >
            <FolderOpen
              aria-hidden
              className="size-[18px] shrink-0 text-primary-50 dark:text-primary-brand-dark"
              strokeWidth={2}
            />
            {location ? (
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-grey-10 dark:text-white" title={location.path}>
                  {location.place}
                </p>
                <p className="truncate text-xs text-grey-50 dark:text-grey-dark-600" title={location.path}>
                  {location.path}
                </p>
              </div>
            ) : status?.state === "ready" ? (
              <p className="min-w-0 flex-1 truncate text-sm text-grey-10 dark:text-white">{status.name}</p>
            ) : (
              <span
                aria-hidden
                className="h-4 w-40 animate-pulse rounded bg-grey-light-200 motion-reduce:animate-none dark:bg-black-500"
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => void choose()}
            disabled={busy || !status}
            className="self-start text-sm font-medium text-primary-50 underline-offset-2 hover:underline disabled:opacity-50 dark:text-primary-brand-dark"
          >
            Choose another location
          </button>
        </div>

        {status?.state === "pending" && !picked && (
          <p role="status" className={TEXT}>
            {status.message}
          </p>
        )}

        {location?.permissionNote && (
          <div className="flex items-start gap-2.5 rounded-[8px] bg-primary-50/10 px-3 py-2.5 dark:bg-primary-brand-dark/15">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-primary-50 dark:text-primary-brand-dark" />
            <p className="text-sm text-grey-10 dark:text-white">{location.permissionNote}</p>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-error-50">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <Button variant="defaultStable" size="auto" onClick={close} className={BUTTON}>
            {ready ? "Cancel" : "Not now"}
          </Button>
          <Button
            variant="primary"
            size="auto"
            loading={busy}
            disabled={!status || (ready && !picked)}
            onClick={() => void create()}
            className={BUTTON}
          >
            {primary}
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
