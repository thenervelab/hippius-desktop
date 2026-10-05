"use client";

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { massDeleteHoldsAtom } from "@/lib/store/syncAtoms";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  classifyMassDeleteError,
  confirmMassDelete,
  getMassDeleteHolds,
  restoreMassDelete,
  type MassDeleteHold,
} from "@/app/lib/tauri/massDelete";
import {
  applyHydration,
  updateHold,
  type MassDeleteHoldView,
} from "@/app/lib/massDelete/holds";
import {
  deviceName,
  progressCopy,
  refusalCopy,
  removeConfirmCopy,
  removeLabel,
} from "@/app/lib/massDelete/copy";
import { isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";

/** The attribute marking each banner's section (`data-mass-delete-banner`),
 *  so "Decide later" can find the next one. */
const BANNER_ATTR = "data-mass-delete-banner";

/**
 * The large-delete prompt: one banner per drive side whose deletes hcfs is
 * holding because a cycle would have removed most of the drive.
 *
 * Restore is the safe answer and comes first; Remove asks again with the
 * count before anything is deleted; "Decide later" hides the banner until
 * the hold next changes or its notification is opened. Rust writes the
 * banner's words and validates every answer against the hold it holds
 * now, refusing a stale one with a structured kind, handled below.
 */
export default function MassDeleteBanner() {
  const holds = useAtomValue(massDeleteHoldsAtom);
  const visible = Array.from(holds.entries()).filter(([, hold]) => !hold.dismissed);
  const announcement = useArrivalAnnouncement(holds);
  return (
    <>
      {/* A banner that appears on its own (a cycle, hydration at launch)
          does not take focus from wherever the user is; it is said here
          instead. Mounted before any banner: a live region announces
          changes to its content, not the content it is mounted with. */}
      <div data-testid="mass-delete-announcer" role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {visible.map(([key, hold]) => (
        <MassDeleteBannerRow key={key} holdKey={key} hold={hold} />
      ))}
    </>
  );
}

/**
 * What the announcer says: the titles of the holds that just appeared (new,
 * or brought back after "Decide later"), and only those. A hold already on
 * screen whose count changed is not announced again here: the user's own
 * answer being refused says so in the banner's status line, and repeating
 * every visible title would read the same banners out on each change.
 */
function useArrivalAnnouncement(holds: ReadonlyMap<string, MassDeleteHoldView>): string {
  const shownRef = useRef<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const held = Array.from(holds).filter(([, hold]) => !hold.dismissed && hold.state === "held");
    const arrived = held.filter(([key]) => !shownRef.current.has(key));
    shownRef.current = new Set(held.map(([key]) => key));
    if (arrived.length > 0) {
      setAnnouncement(arrived.map(([, hold]) => `${hold.title}.`).join(" "));
    }
  }, [holds]);

  return announcement;
}

type Answer = "restore" | "remove";

function MassDeleteBannerRow({ holdKey, hold }: { holdKey: string; hold: MassDeleteHoldView }) {
  // The count the Remove confirmation opened with, while it is open. The
  // dialog shows and sends this snapshot, not the live count: a hold that
  // grows while it is open must not change the number the user agreed to.
  // Rust refuses the stale count (HoldChanged), and the banner asks again.
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const device = deviceName(isMacPlatform());
  const progress = progressCopy(hold);
  const titleId = useId();

  const focus = useBannerFocus({
    holdKey,
    count: hold.count,
    canRestore: hold.canRestore,
    answerable: progress === null,
    dialogOpen: confirmCount !== null,
  });
  const { busy, answer, decideLater } = useMassDeleteAnswer(holdKey, hold, focus);
  const confirm = removeConfirmCopy({ ...hold, count: confirmCount ?? hold.count }, device);

  return (
    <>
      {/* A labelled region, not role="alert": an alert is read out at once
          and is not meant to hold controls. The page-wide announcer says
          when it appears; later changes go through the status line. */}
      <section
        ref={focus.sectionRef}
        aria-labelledby={titleId}
        data-mass-delete-banner=""
        className="relative overflow-hidden rounded-xl border border-warning-50/40 bg-gradient-to-r from-warning-50/[0.14] to-warning-50/[0.04] px-4 py-3.5 mt-2 dark:border-warning-50/35 dark:from-warning-50/[0.16] dark:to-warning-50/[0.05]"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-50">
            <Icons.OctagonAlert className="size-4 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-sm font-semibold text-grey-10 dark:text-white">
              {hold.title}
            </p>
            {hold.body.map((line) => (
              <p key={line} className="text-xs text-grey-50 dark:text-grey-dark-700">
                {line}
              </p>
            ))}
            <BannerStatus statusRef={focus.statusRef} hold={hold} progress={progress} />
          </div>
          {progress === null && (
            <BannerActions
              hold={hold}
              busy={busy}
              removeText={removeLabel(hold.side, device)}
              restoreRef={focus.restoreRef}
              laterRef={focus.laterRef}
              onRestore={() => void answer("restore", hold.count)}
              onRemove={() => setConfirmCount(hold.count)}
              onLater={decideLater}
            />
          )}
        </div>
      </section>

      {/* Radix dialog: focus is trapped inside, and Escape, the close button
          and a click outside all cancel; only the Remove button removes. */}
      <ConfirmDialog
        open={confirmCount !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmCount(null);
        }}
        title={confirm.title}
        description={confirm.description}
        cancelText="Keep files"
        confirmText={confirm.confirm}
        variant="danger"
        onConfirm={() => answer("remove", confirmCount ?? hold.count)}
      />
    </>
  );
}

/** The banner's live status line: a refusal, a notice, or progress. */
function BannerStatus({
  statusRef,
  hold,
  progress,
}: {
  statusRef: RefObject<HTMLDivElement | null>;
  hold: MassDeleteHoldView;
  progress: string | null;
}) {
  return (
    <div
      ref={statusRef}
      role="status"
      aria-live="polite"
      tabIndex={-1}
      className="outline-none focus-visible:ring-2 focus-visible:ring-warning-50 rounded"
    >
      {hold.refusal && (
        <p className="text-xs font-medium text-grey-10 dark:text-white">
          {refusalCopy(hold.refusal)}
        </p>
      )}
      {hold.notice && (
        <p className="text-xs font-medium text-grey-10 dark:text-white">{hold.notice}</p>
      )}
      {progress && (
        <p className="mt-1 flex items-center gap-2 text-sm text-grey-10 dark:text-white">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {progress}
        </p>
      )}
    </div>
  );
}

interface BannerActionsProps {
  hold: MassDeleteHoldView;
  busy: Answer | null;
  removeText: string;
  restoreRef: RefObject<HTMLButtonElement | null>;
  laterRef: RefObject<HTMLButtonElement | null>;
  onRestore: () => void;
  onRemove: () => void;
  onLater: () => void;
}

/** Restore (the safe answer, first and only when allowed), Remove, and
 *  Decide later. */
function BannerActions(props: BannerActionsProps) {
  const { hold, busy, removeText, restoreRef, laterRef, onRestore, onRemove, onLater } = props;
  const size = "h-[30px] rounded-[6px] px-3 font-geist text-[14px]";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {hold.canRestore && (
        <Button
          ref={restoreRef}
          variant="primary"
          size="auto"
          className={size}
          onClick={onRestore}
          loading={busy === "restore"}
          disabled={busy !== null}
        >
          Restore files
        </Button>
      )}
      <Button
        variant="destructive"
        size="auto"
        className={`${size} text-white`}
        onClick={onRemove}
        disabled={busy !== null}
      >
        {removeText}
      </Button>
      <Button
        ref={laterRef}
        variant="defaultStable"
        size="auto"
        className={`${size} !bg-transparent text-grey-10 dark:text-white`}
        onClick={onLater}
        disabled={busy !== null}
      >
        Decide later
      </Button>
    </div>
  );
}

/**
 * Sending an answer and handling Rust's refusal of it, by kind. The words
 * of each refusal are Rust's (`message`); only what the banner does about
 * it is decided here.
 */
function useMassDeleteAnswer(
  holdKey: string,
  hold: MassDeleteHoldView,
  focus: Pick<BannerFocus, "requestRestoreFocus" | "sectionRef">,
) {
  const setHolds = useSetAtom(massDeleteHoldsAtom);
  const [busy, setBusy] = useState<Answer | null>(null);
  const { requestRestoreFocus, sectionRef } = focus;
  const { label, side } = hold;

  const patch = useCallback(
    (fields: Partial<MassDeleteHoldView>) => setHolds((prev) => updateHold(prev, holdKey, fields)),
    [setHolds, holdKey],
  );

  /** Read Rust's holds back; returns them, or `null` when the read failed. */
  const refresh = useCallback(async (): Promise<MassDeleteHold[] | null> => {
    try {
      const current = await getMassDeleteHolds();
      setHolds((prev) => applyHydration(prev, current));
      return current;
    } catch (err) {
      console.warn("[MassDelete] Could not refresh the held deletes:", err);
      return null;
    }
  }, [setHolds]);

  /**
   * The hold changed under the user's answer. The refusal carries only the
   * new count, so the whole hold (its title, its baseline, the empty-root
   * advice) is read back from Rust. If that in-memory read fails, the
   * refusal's count is still what the next answer sends, and the notice
   * says it; the title keeps its old count until the next hold event.
   */
  const askAgain = useCallback(
    async (held: number, notice: string) => {
      const current = await refresh();
      const latest = current?.find((h) => h.label === label && h.side === side);
      if (current && !latest) return;
      patch({ count: latest?.count ?? held, requested: null, notice });
    },
    [refresh, patch, label, side],
  );

  const handleRefusal = useCallback(
    async (err: unknown) => {
      const refusal = classifyMassDeleteError(err);
      switch (refusal.type) {
        case "nothingHeld":
          if (refusal.message) toast.info(refusal.message);
          await refresh();
          return;
        case "holdChanged":
          // Asked again because of the user's own answer: they are
          // answering, so the safe answer takes focus again.
          requestRestoreFocus();
          await askAgain(refusal.held, refusal.message);
          return;
        case "restoreInProgress":
          if (refusal.message) toast.info(refusal.message);
          return;
        case "memberCannotRestore":
          // Rust's hold said this account could restore, so its lines do
          // not say who can; Rust's refusal does.
          patch({ canRestore: false, notice: refusal.message || null });
          return;
        case "other":
          toast.error("Couldn't send your choice", { description: tauriErrorMessage(err) });
      }
    },
    [patch, refresh, askAgain, requestRestoreFocus],
  );

  const answer = useCallback(
    async (kind: Answer, count: number) => {
      setBusy(kind);
      try {
        const send = kind === "restore" ? restoreMassDelete : confirmMassDelete;
        await send(label, side, count);
        patch({ requested: kind, notice: null });
      } catch (err) {
        await handleRefusal(err);
      } finally {
        setBusy(null);
      }
    },
    [label, side, patch, handleRefusal],
  );

  /** "Decide later": focus moves on first, so it does not fall to the page
   *  body with the banner that held it. */
  const decideLater = useCallback(() => {
    focusAfterDismiss(sectionRef.current);
    patch({ dismissed: true });
  }, [patch, sectionRef]);

  return { busy, answer, decideLater };
}

/**
 * Where focus goes when `section` is dismissed: the next banner's safe
 * answer (its first button: Restore, or Remove when this account cannot
 * restore), else the previous banner's, else the page's main heading.
 * Each is there after the dismissal re-renders; the page body is not a
 * place a keyboard user can continue from.
 */
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

interface BannerFocusInput {
  holdKey: string;
  count: number;
  canRestore: boolean;
  /** The answer buttons are shown (no answer or restore in progress). */
  answerable: boolean;
  dialogOpen: boolean;
}

type BannerFocus = ReturnType<typeof useBannerFocus>;

/**
 * Where keyboard focus goes in a banner.
 *
 * - Restore is first in tab order, and the safe answer takes focus when the
 *   hold appears or changes, or its buttons change, but only when that
 *   takes focus from no one: nothing is focused, or focus is already in
 *   this banner. A hold that arrives on its own while the user types
 *   elsewhere leaves their focus alone (the page-wide announcer says it).
 *   Decide later stands in when this account cannot restore, including
 *   right after a refused restore took the Restore button away.
 * - After the user's own answer was refused because the hold changed, the
 *   safe answer takes focus whatever had it: they are answering this banner.
 *   This includes the answer sent from the Remove confirmation, so the move
 *   waits for the confirmation to close.
 * - When the buttons go away (an answer accepted, the confirmation closed
 *   over a vanished trigger), focus would fall to the page body; it goes to
 *   the status line, which says what is happening.
 *
 * Every move is checked a tick later, after Radix's own close-time focus
 * restore has run, against where focus actually is then.
 */
function useBannerFocus({ holdKey, count, canRestore, answerable, dialogOpen }: BannerFocusInput) {
  const sectionRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  // The hold and buttons focus was last placed for, and whether the user's
  // own answer asked for focus on Restore.
  const placedForRef = useRef<string | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (dialogOpen) return;
    const shown = `${holdKey}\u0000${count}\u0000${answerable}\u0000${canRestore}`;
    const changed = placedForRef.current !== shown;
    placedForRef.current = shown;
    if (!changed && !requestedRef.current) return;

    // The request is taken when the move runs, so a re-render that cancels
    // this timer leaves it for the next one.
    const timer = setTimeout(() => {
      const requested = requestedRef.current;
      requestedRef.current = false;
      if (!requested && !focusIsFree(sectionRef.current)) return;
      (restoreRef.current ?? laterRef.current)?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [holdKey, count, canRestore, answerable, dialogOpen]);

  useEffect(() => {
    if (dialogOpen) return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) statusRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [answerable, canRestore, dialogOpen]);

  const requestRestoreFocus = useCallback(() => {
    requestedRef.current = true;
  }, []);

  return { sectionRef, restoreRef, laterRef, statusRef, requestRestoreFocus };
}

/** Moving focus into `section` takes it from no one. */
function focusIsFree(section: HTMLElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (section?.contains(active) ?? false);
}
