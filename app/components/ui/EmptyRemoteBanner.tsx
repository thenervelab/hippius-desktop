"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { emptyRemoteDrivesAtom } from "@/lib/store/syncAtoms";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  classifyEmptyRemoteError,
  confirmEmptyRemote,
  getEmptyRemoteDrives,
} from "@/app/lib/tauri/emptyRemote";
import {
  applyHydration,
  updateDrive,
  type EmptyRemoteDrives,
  type EmptyRemoteView,
} from "@/app/lib/emptyRemote/drives";
import {
  CONFIRM_LABEL,
  KEEP_LABEL,
  confirmCopy,
  confirmingCopy,
} from "@/app/lib/emptyRemote/copy";
import { deviceName } from "@/app/lib/massDelete/copy";
import { isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";

/** The attribute marking each banner's section, so "Keep my files" can
 *  find the next one. */
const BANNER_ATTR = "data-empty-remote-banner";

/**
 * The empty-drive prompt: one banner per drive whose server listing came
 * back empty while this device still has its files. hcfs refuses that
 * listing, so nothing is deleted and the drive does not sync until it is
 * resolved.
 *
 * "Keep my files" is the safe answer and comes first: it changes nothing
 * and puts the banner away until the prompt changes or its notification is
 * opened. The owner may instead confirm the drive really is empty, which
 * asks again before the copies here are removed. A shared-drive member is
 * never offered that; Rust's lines say why. Rust writes the banner's words
 * and validates the answer, refusing a stale one with a structured kind.
 */
export default function EmptyRemoteBanner() {
  const drives = useAtomValue(emptyRemoteDrivesAtom);
  const visible = Array.from(drives.values()).filter((drive) => !drive.dismissed);
  const announcement = useArrivalAnnouncement(drives);
  return (
    <>
      {/* A banner that appears on its own does not take focus from wherever
          the user is; it is said here instead. Mounted before any banner: a
          live region announces changes, not what it is mounted with. */}
      <div data-testid="empty-remote-announcer" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {visible.map((drive) => (
        <EmptyRemoteBannerRow key={drive.label} drive={drive} />
      ))}
    </>
  );
}

/** The titles of the prompts that just appeared (new, or brought back),
 *  and only those. */
function useArrivalAnnouncement(drives: EmptyRemoteDrives): string {
  const shownRef = useRef<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const shown = Array.from(drives.values()).filter((drive) => !drive.dismissed);
    const arrived = shown.filter((drive) => !shownRef.current.has(drive.label));
    shownRef.current = new Set(shown.map((drive) => drive.label));
    if (arrived.length > 0) {
      setAnnouncement(arrived.map((drive) => `${drive.title}.`).join(" "));
    }
  }, [drives]);

  return announcement;
}

function EmptyRemoteBannerRow({ drive }: { drive: EmptyRemoteView }) {
  // The count the confirmation opened with, while it is open: the dialog
  // shows this snapshot, not a count that changes under the user.
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const device = deviceName(isMacPlatform());
  const titleId = useId();
  const { busy, confirm, keep } = useEmptyRemoteAnswer(drive, sectionRef);
  const dialog = confirmCopy({ ...drive, syncedCount: confirmCount ?? drive.syncedCount }, device);

  return (
    <>
      {/* A labelled region, not role="alert": an alert is read out at once
          and is not meant to hold controls. */}
      <section
        ref={sectionRef}
        aria-labelledby={titleId}
        data-empty-remote-banner=""
        className="relative overflow-hidden rounded-xl border border-warning-50/40 bg-gradient-to-r from-warning-50/[0.14] to-warning-50/[0.04] px-4 py-3.5 mt-2 dark:border-warning-50/35 dark:from-warning-50/[0.16] dark:to-warning-50/[0.05]"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-50">
            <Icons.OctagonAlert className="size-4 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-sm font-semibold text-grey-10 dark:text-white">
              {drive.title}
            </p>
            {drive.body.map((line) => (
              <p key={line} className="text-xs text-grey-50 dark:text-grey-dark-700">
                {line}
              </p>
            ))}
            <div role="status" aria-live="polite">
              {drive.notice && (
                <p className="text-xs font-medium text-grey-10 dark:text-white">{drive.notice}</p>
              )}
              {drive.confirming && (
                <p className="mt-1 flex items-center gap-2 text-sm text-grey-10 dark:text-white">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {confirmingCopy(drive, device)}
                </p>
              )}
            </div>
          </div>
          {!drive.confirming && (
            <BannerActions
              canConfirm={drive.canConfirm}
              busy={busy}
              onKeep={keep}
              onConfirm={() => setConfirmCount(drive.syncedCount)}
            />
          )}
        </div>
      </section>

      {/* Radix dialog: Escape, the close button and a click outside all
          keep the files; only the destructive button removes them. */}
      <ConfirmDialog
        open={confirmCount !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmCount(null);
        }}
        title={dialog.title}
        description={dialog.description}
        cancelText={KEEP_LABEL}
        confirmText={dialog.confirm}
        variant="danger"
        onConfirm={confirm}
      />
    </>
  );
}

interface BannerActionsProps {
  canConfirm: boolean;
  busy: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}

/** "Keep my files" (the safe answer, first), and for an owner the first
 *  step towards removing the copies here. */
function BannerActions({ canConfirm, busy, onKeep, onConfirm }: BannerActionsProps) {
  const size = "h-[30px] rounded-[6px] px-3 font-geist text-[14px]";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" size="auto" className={size} onClick={onKeep} disabled={busy}>
        {KEEP_LABEL}
      </Button>
      {canConfirm && (
        <Button
          variant="destructive"
          size="auto"
          className={`${size} text-white`}
          onClick={onConfirm}
          loading={busy}
          disabled={busy}
        >
          {CONFIRM_LABEL}
        </Button>
      )}
    </div>
  );
}

/**
 * Sending the confirmation and handling Rust's refusal of it, by kind. The
 * words of each refusal are Rust's (`message`); only what the banner does
 * about it is decided here.
 */
function useEmptyRemoteAnswer(
  drive: EmptyRemoteView,
  sectionRef: RefObject<HTMLElement | null>,
) {
  const setDrives = useSetAtom(emptyRemoteDrivesAtom);
  const [busy, setBusy] = useState(false);
  const { label } = drive;

  const patch = useCallback(
    (fields: Partial<EmptyRemoteView>) => setDrives((prev) => updateDrive(prev, label, fields)),
    [setDrives, label],
  );

  const refresh = useCallback(async () => {
    try {
      const current = await getEmptyRemoteDrives();
      setDrives((prev) => applyHydration(prev, current));
    } catch (err) {
      console.warn("[EmptyRemote] Could not refresh the empty drives:", err);
    }
  }, [setDrives]);

  const confirm = useCallback(async () => {
    setBusy(true);
    try {
      await confirmEmptyRemote(label);
      patch({ confirming: true, notice: null });
    } catch (err) {
      const refusal = classifyEmptyRemoteError(err);
      switch (refusal.type) {
        case "nothingHeld":
          if (refusal.message) toast.info(refusal.message);
          await refresh();
          return;
        case "memberCannotConfirm":
          patch({ canConfirm: false, notice: refusal.message || null });
          return;
        case "other":
          toast.error("Couldn't send your choice", { description: tauriErrorMessage(err) });
      }
    } finally {
      setBusy(false);
    }
  }, [label, patch, refresh]);

  /** "Keep my files": focus moves on first, so it does not fall to the page
   *  body with the banner that held it. */
  const keep = useCallback(() => {
    focusAfterDismiss(sectionRef.current);
    patch({ dismissed: true });
  }, [patch, sectionRef]);

  return { busy, confirm, keep };
}

/** Where focus goes when `section` is put away: the next banner's first
 *  button, else the previous one's, else the page's main heading. */
function focusAfterDismiss(section: HTMLElement | null): void {
  const banners = Array.from(document.querySelectorAll<HTMLElement>(`[${BANNER_ATTR}]`));
  const index = section ? banners.indexOf(section) : -1;
  const neighbour = banners[index + 1] ?? (index > 0 ? banners[index - 1] : undefined);
  const button = neighbour?.querySelector<HTMLButtonElement>("button:not([disabled])");
  if (button) {
    button.focus();
    return;
  }
  const heading = document.querySelector<HTMLElement>("main h1, main h2");
  if (heading) {
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }
}
