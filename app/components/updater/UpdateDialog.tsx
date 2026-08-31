"use client";

import React, { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAtomValue } from "jotai";
import {
  checkForUpdate,
  installUpdate,
  type AvailableUpdate,
} from "@/lib/tauri/updates";
import { tauriErrorDetail } from "@/lib/utils/dispatchTauriError";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { getUpdateInstallPlan } from "@/app/components/updater/updateInstallPlan";
import { getVersion as getAppVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

import { Icons } from "@/components/ui";
import { HippiusLogo } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  TITLEBAR_BAND_H_44,
  titlebarClearanceClass,
} from "@/app/lib/utils/platformChrome";

import {
  closeUpdateDialog,
  confirmUpdate,
  forcedProgressAtom,
  forcedStatusAtom,
  updateDialogOpenAtom,
  updateStore,
} from "./updateStore";
import BasicMarkdown from "./BasicMarkdown";
import { UPDATE_FAILED_FALLBACK } from "./checkForUpdates";

/* Dev-only mock data. Used when the dev panel forces a state — the
 * real `update` object is null when no update is actually available,
 * so we substitute this so the "available" / "downloading" previews
 * can show realistic version / release-notes / byte-counter content.
 * Stripped at build time because `IS_DEV` short-circuits the path. */
const IS_DEV = process.env.NODE_ENV === "development";
const MOCK_VERSION = "0.4.1.3";
const MOCK_TOTAL_BYTES = 12 * 1024 * 1024; // 12 MB
const MOCK_BODY = `## What's New

We've made a couple of improvements to the Drive experience that have been bugging users for a while.

## Improvements

**Files and folders now sort the way you'd expect** Files and folders in My Drive are now sorted the same way macOS Finder sorts them. Symbols and underscores come first, then numbered files in the right order (so \`file9\` shows before \`file10\`), then everything else alphabetically.

**Filter dropdowns now open in the right place** Clicking the File Type, Size, or other filters now opens the menu anchored to the trigger button instead of jumping to the corner of the screen.`;

/* Unified update dialog replacing the previous UpdateDownloadDialog +
 * CheckForUpdateDialog pair. Full-screen overlay that mimics the login
 * page chrome (AuthLayout) — 42% left pane carrying the Hippius brand
 * illustration, 58% right pane carrying a compact state card. Six
 * lifecycle states share the same card chrome:
 *
 *   checking → available → downloading → installing → complete
 *   no-update / error  (terminal branches)
 *
 * The dialog is self-contained: re-runs the Rust check_for_update on open,
 * drives install_update internally, calls relaunch() on
 * the user's Restart App click. The store atom (updateDialogOpenAtom)
 * is the only external trigger — auto-mount via UpdateChecker →
 * checkForUpdates → store, manual mount via TopBarLogoMenu setting the
 * atom directly. */

type Status =
  | "checking"
  | "available"
  | "no-update"
  | "downloading"
  | "installing"
  | "complete"
  | "error";

function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/* Eases a numeric value from its previous setting to a new target over
 * `durationMs` using a cubic ease-out curve. Drives the progress bar +
 * percentage display so users see continuous motion between the
 * coarse byte progress emitted by Rust's install_update (chunks
 * arrive at network cadence, often hundreds of ms apart and large
 * enough that a naive bind to `downloadProgress` makes the bar tick in
 * visible jumps). The hook holds the in-flight value in a ref so that
 * a new target arriving mid-animation continues from the actual
 * rendered value, never snapping. */
function useSmoothNumber(target: number, durationMs = 450): number {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = valueRef.current;
    const end = target;
    if (start === end) return;

    const startTime =
      typeof performance !== "undefined" ? performance.now() : Date.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const next = start + (end - start) * eased;
      valueRef.current = next;
      setValue(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        valueRef.current = end;
        setValue(end);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs]);

  return value;
}

/* Vertical-bar progress indicator matching Figma — fixed 4px wide,
 * 24px tall bars with a 2px gap, filling left-to-right. 72 bars tiles
 * across the card's ~432px content width at exactly 4px each. Active
 * bars use the primary blue; the rest stay neutral grey. Per-bar
 * transition uses `ease-out` so the leading edge "lights up" gently
 * instead of snapping when the smoothed progress nudges it past the
 * next threshold. */
function ProgressBar({ progress }: { progress: number }) {
  const totalBars = 72;
  const clamped = Math.max(0, Math.min(100, progress));
  const activeBars = Math.round((clamped / 100) * totalBars);
  return (
    <div className="flex h-6 w-full items-stretch gap-[2px] overflow-hidden">
      {Array.from({ length: totalBars }, (_, i) => (
        <div
          key={i}
          className={cn(
            "h-full w-1 shrink-0 rounded-[1px] transition-colors duration-300 ease-out",
            i < activeBars
              ? "bg-primary-50 dark:bg-primary-65"
              : "bg-[#E9E9E9] dark:bg-[#1E1E1E]",
          )}
        />
      ))}
    </div>
  );
}

/* Per-state pill chip rendered above the title. Background, icon and
 * label all vary; the chrome (rounded-full, tracking, font-size) stays
 * uniform so the card reads as one component across states. */
function StatePill({ status }: { status: Status }) {
  type PillCfg = {
    label: string;
    bg: string;
    text: string;
    icon?: React.ReactNode;
  };

  const cfg: PillCfg = (() => {
    switch (status) {
      case "checking":
        return {
          label: "Checking",
          bg: "bg-primary-50",
          text: "text-white",
        };
      case "available":
        return {
          label: "Update Available",
          bg: "bg-primary-50",
          text: "text-white",
        };
      case "no-update":
        return {
          label: "Version is Up to Date",
          bg: "bg-primary-50",
          text: "text-white",
        };
      case "downloading":
      case "installing":
        return {
          label: "Update in Progress",
          bg: "bg-warning-50",
          text: "text-white",
          icon: (
            <Icons.Refresh
              className="size-2.5 animate-spin"
              strokeWidth={2}
            />
          ),
        };
      case "complete":
        return {
          label: "Update Completed",
          bg: "bg-[#04C870]",
          text: "text-white",
          icon: (
            <Icons.TickCircle className="size-2.5" strokeWidth={2} />
          ),
        };
      case "error":
        return {
          label: "Update Failed",
          bg: "bg-error-50",
          text: "text-white",
        };
    }
  })();

  return (
    <span
      className={cn(
        "inline-flex h-[19px] items-center gap-[4px] rounded-full px-[7px] py-[3px] text-[10px] font-medium leading-[12.37px] tracking-[-0.2px]",
        cfg.bg,
        cfg.text,
      )}
    >
      {cfg.icon}
      <span>{cfg.label}</span>
    </span>
  );
}

export default function UpdateDialog() {
  const open = useAtomValue(updateDialogOpenAtom, { store: updateStore });

  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const platform = (navigator.platform || "").toLowerCase();
    const ua = (navigator.userAgent || "").toLowerCase();
    setIsMac(platform.includes("mac") || ua.includes("mac os"));
  }, []);

  const [status, setStatus] = useState<Status>("checking");
  const [errorDetail, setErrorDetail] = useState<string>("");
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [installProgress, setInstallProgress] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);

  // Refs mirror the byte counters so the install progress callback
  // doesn't capture stale closures across rerenders.
  const downloadedBytesRef = useRef(0);
  const totalBytesRef = useRef(0);

  /* --- Dev override layer ---
   *
   * UpdateDialogDevPanel can flip these atoms to preview any lifecycle
   * state without an actual update sitting on the server. The handlers
   * and state machine below still read the REAL state (`status`,
   * `update`, etc.) so clicking through doesn't try to install a fake
   * release. The render-time conditionals further down use the
   * `effective*` derivations instead, so the dialog renders whichever
   * state was forced. Stripped at build time when NODE_ENV !==
   * "development" because every read sits inside an IS_DEV gate. */
  const forcedStatus = useAtomValue(forcedStatusAtom, { store: updateStore });
  const forcedProgress = useAtomValue(forcedProgressAtom, {
    store: updateStore,
  });
  const devForced = IS_DEV ? forcedStatus : null;

  const effectiveStatus: Status = devForced ?? status;
  const effectiveUpdate: AvailableUpdate | null =
    devForced === "available" || devForced === "downloading"
      ? {
          version: MOCK_VERSION,
          currentVersion: MOCK_VERSION,
          notes: MOCK_BODY,
          channel: "production",
          installInPlace: true,
          releasePageUrl:
            "https://github.com/thenervelab/hippius-desktop/releases/latest",
          manualInstallHint:
            "Download the installer from https://github.com/thenervelab/hippius-desktop/releases/latest and run it.",
        }
      : update;
  const effectiveDownloadProgress =
    devForced === "downloading" ? forcedProgress : downloadProgress;
  const effectiveInstallProgress =
    devForced === "installing" ? forcedProgress : installProgress;
  const effectiveDownloadedBytes =
    devForced === "downloading"
      ? Math.round((MOCK_TOTAL_BYTES * forcedProgress) / 100)
      : downloadedBytes;
  const effectiveTotalBytes =
    devForced === "downloading" ? MOCK_TOTAL_BYTES : totalBytes;
  const effectiveCurrentVersion = devForced
    ? currentVersion || MOCK_VERSION
    : currentVersion;

  // Smoothed progress value drives both the bar fill AND the percent
  // label so they share one motion. Choose which raw progress feeds
  // the hook based on whichever lifecycle phase is active; the hook
  // continues from its current rendered value when the target swaps,
  // so the installing phase picks up where downloading left off.
  const targetProgress =
    effectiveStatus === "downloading"
      ? effectiveDownloadProgress
      : effectiveStatus === "installing"
        ? effectiveInstallProgress
        : 0;
  const smoothProgress = useSmoothNumber(targetProgress);
  const smoothBytes = useSmoothNumber(effectiveDownloadedBytes);

  // Once the user clicks Update, the dialog is non-dismissable until the
  // install lifecycle ends. Dev overrides also flip this so the close
  // button hides while previewing the downloading / installing states.
  const isInProgress =
    effectiveStatus === "downloading" ||
    effectiveStatus === "installing" ||
    effectiveStatus === "complete";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const run = async () => {
      setStatus("checking");
      setUpdate(null);
      setErrorDetail("");
      setDownloadProgress(0);
      setInstallProgress(0);
      setDownloadedBytes(0);
      setTotalBytes(0);

      try {
        const [u, ver] = await Promise.all([
          checkForUpdate(),
          getAppVersion().catch(() => ""),
        ]);
        if (cancelled) return;
        setCurrentVersion(ver || "");
        if (u) {
          setUpdate(u);
          setStatus("available");
        } else {
          setStatus("no-update");
        }
      } catch {
        if (!cancelled) setStatus("error");
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const resetAndClose = () => {
    if (isInProgress) return;
    closeUpdateDialog();
    confirmUpdate(false);
  };

  // The install step reports no progress of its own — Rust's `install_update`
  // streams download bytes and then blocks through the install. We fake a
  // 5-phase progress so the user sees forward motion before the relaunch.
  const simulateInstallation = async () => {
    const phases = [20, 40, 60, 80, 100];
    for (const phase of phases) {
      await new Promise((r) => setTimeout(r, 500));
      setInstallProgress(phase);
    }
    setStatus("complete");
  };

  const handleUpdateNow = async () => {
    if (!update) return;

    const plan = getUpdateInstallPlan(update);
    if (plan.kind === "manual") {
      try {
        await openUrl(plan.url);
        closeUpdateDialog();
      } catch (err) {
        console.error("Could not open the release page:", err);
        setErrorDetail(plan.hint);
        setStatus("error");
      }
      return;
    }

    try {
      setStatus("downloading");
      setDownloadProgress(0);
      setInstallProgress(0);
      setDownloadedBytes(0);
      setTotalBytes(0);
      downloadedBytesRef.current = 0;
      totalBytesRef.current = 0;

      // Rust reports CUMULATIVE bytes, not per-chunk deltas, so this assigns
      // rather than accumulating. There is no "Started"/"Finished" pair
      // either: the first message starts the bar and the awaited promise
      // resolving is what ends it.
      await installUpdate(({ bytesDone, bytesTotal }) => {
        if (bytesTotal != null && bytesTotal !== totalBytesRef.current) {
          totalBytesRef.current = bytesTotal;
          setTotalBytes(bytesTotal);
        }
        downloadedBytesRef.current = bytesDone;
        setDownloadedBytes(bytesDone);
        const pct =
          totalBytesRef.current > 0
            ? (bytesDone / totalBytesRef.current) * 100
            : 0;
        setDownloadProgress(Math.min(Math.round(pct), 100));
      });

      setDownloadProgress(100);
      setStatus("installing");
      await simulateInstallation();
    } catch (err) {
      console.error("Update failed:", err);
      // `updates.rs` owns every sentence this can carry — including the
      // manual-install instruction and the release-page link for the running
      // channel. Show it verbatim; do not restate it or add a second flow.
      // An IPC transport failure carries no message and keeps the fallback.
      const detail = tauriErrorDetail(err);
      setErrorDetail(detail);
      setStatus("error");
      toast.error("Update failed", {
        description: detail || UPDATE_FAILED_FALLBACK,
      });
    }
  };

  const handleRestart = async () => {
    try {
      await relaunch();
    } catch (err) {
      console.error("Restart failed:", err);
      toast.error("Unable to restart the app. Please restart manually.");
    }
  };

  const handleRetryCheck = async () => {
    setStatus("checking");
    setUpdate(null);
    setErrorDetail("");
    try {
      const [u, ver] = await Promise.all([
        checkForUpdate(),
        getAppVersion().catch(() => ""),
      ]);
      setCurrentVersion(ver || "");
      if (u) {
        setUpdate(u);
        setStatus("available");
      } else {
        setStatus("no-update");
      }
    } catch {
      setStatus("error");
    }
  };

  if (!open) return null;

  // Title varies per state. Body text below the title also varies but
  // is generated inline next to its consumers so each state's content
  // reads as a single block.
  const title = (() => {
    switch (effectiveStatus) {
      case "checking":
        return "Checking for updates";
      case "available":
        return "New Update Available!";
      case "downloading":
        return "Please Wait While Your Update Is Downloading";
      case "installing":
        return "Please Wait While Your Update Is Installed";
      case "complete":
        return "Update Has Been Successfully Installed";
      case "no-update":
        return "No Update is Available At The Moment";
      case "error":
        return "Something went wrong";
    }
  })();

  // Whether the card has a primary CTA below the body. "checking",
  // "downloading", "installing" deliberately have no CTA.
  const installPlan = effectiveUpdate
    ? getUpdateInstallPlan(effectiveUpdate)
    : { kind: "in-place" as const };

  const cta = (() => {
    switch (effectiveStatus) {
      case "available":
        return {
          label: installPlan.kind === "manual" ? "Download" : "Update",
          onClick: handleUpdateNow,
        };
      case "complete":
        return { label: "Restart App", onClick: handleRestart };
      case "no-update":
        return { label: "Check Again", onClick: handleRetryCheck };
      case "error":
        return { label: "Try Again", onClick: handleRetryCheck };
      default:
        return null;
    }
  })();

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => !next && resetAndClose()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10000] bg-black/30 backdrop-blur-[8px] dark:bg-black/60 animate-fade-in-0.2" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            if (isInProgress) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            // Radix's PointerDownOutsideEvent is a CustomEvent — its
            // `target` is the dispatch target (an internal element),
            // NOT the actual click target. To check whether the user
            // clicked the dev panel, we have to dig into
            // `detail.originalEvent.target`.
            const original = (
              e as unknown as CustomEvent<{ originalEvent: PointerEvent }>
            ).detail?.originalEvent?.target as HTMLElement | null;
            if (original?.closest("[data-update-dev-panel]")) {
              e.preventDefault();
              return;
            }
            if (isInProgress) e.preventDefault();
          }}
          className="fixed inset-0 z-[10001] flex outline-none"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>

          {/* Full-screen background — matches the login page. */}
          <div className="fixed inset-0 bg-cover bg-center bg-no-repeat bg-[url('/logged-out-app-background.png')] dark:bg-[url('/logged-out-app-background-dark.png')]" />

          {/* AuthLayout-mirrored shell. 42% left = brand panel,
              58% right = compact state card. */}
          <main className="relative h-full w-full flex items-stretch p-[min(0.25rem,4px)]">
            {/* LEFT PANE — Hippius wordmark + static illustration.
                Same recipe as LeftCarouselPanel minus the swiper and
                pagination dots, per "no carousel/crowd at the bottom". */}
            <div className="w-[42%] shrink-0 grow-0 h-full">
              <div className="relative w-full h-full rounded-[11px] bg-grey-light-200 dark:bg-black-500 overflow-hidden flex flex-col">
                {/* Title bar — Hippius logo + wordmark, mac-aware
                    spacing so it slots in beside the traffic-light dots
                    on macOS. Mirrors AuthTitleBar. */}
                <div
                  data-tauri-drag-region
                  className={cn(
                    "relative z-10 flex items-center w-full select-none shrink-0",
                    TITLEBAR_BAND_H_44,
                    titlebarClearanceClass(isMac),
                  )}
                >
                  <div className="flex items-center gap-[8px] px-[4px] py-[5px] rounded-[9px] pointer-events-none">
                    <HippiusLogo className="size-[28px] text-primary-50" />
                    <span className="font-[557] text-[18px] leading-[18px] text-primary-50 tracking-[0px]">
                      Hippius
                    </span>
                  </div>
                </div>

                {/* Illustration — dedicated laptop-with-chip render
                    from /public/assets/update-app. Light + dark
                    variants swap via the `dark:` class toggle so the
                    illustration stays legible against either card
                    surface. */}
                <div className="flex-1 min-h-0 w-full relative overflow-hidden">
                  <img
                    src="/assets/update-app/laptop.png"
                    alt="Hippius update"
                    className="absolute left-0 top-1/2 -translate-y-[57%] w-full h-auto block select-none pointer-events-none dark:hidden"
                    draggable={false}
                  />
                  <img
                    src="/assets/update-app/laptop-dark.png"
                    alt="Hippius update"
                    className="absolute left-0 top-1/2 -translate-y-[57%] w-full h-auto hidden select-none pointer-events-none dark:block"
                    draggable={false}
                  />
                </div>
              </div>
            </div>

            {/* RIGHT PANE — compact state card centered both axes. */}
            <div className="w-[58%] shrink-0 grow-0 h-full flex items-center justify-center px-[min(2rem,32px)] py-6">
              <motion.div
                initial={{ opacity: 0, y: 12, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="relative w-full max-w-[480px]"
              >
                {/* Card */}
                <div className="relative flex flex-col items-stretch gap-[26px] rounded-[12px] bg-white p-6 shadow-[0px_14px_31px_0px_rgba(0,0,0,0.06),0px_56px_56px_0px_rgba(0,0,0,0.05)] dark:bg-[#161616] dark:shadow-[0px_14px_31px_0px_rgba(0,0,0,0.4)]">
                  {/* Close button — anchored inside the card at top-right.
                      Hidden during install so users can't bail mid-write. */}
                  {!isInProgress && (
                    <Dialog.Close asChild>
                      <button
                        aria-label="Close"
                        className="absolute right-4 top-4 z-10 text-[#0a0a0a] hover:text-[#737373] dark:text-white dark:hover:text-[#a3a3a3] transition-colors"
                      >
                        <X className="size-5" />
                      </button>
                    </Dialog.Close>
                  )}
                  {/* Header — logo decoration + pill + title + subtitle */}
                  <div className="flex w-full flex-col items-center gap-[12px]">
                    {/* Logo + grid decoration. The Decoration component
                        paints a 56×56 brand-blue grid revealed inside
                        an elliptical mask. It draws no surface colors —
                        the card itself shows through wherever the mask
                        hides — so the same SVG works in light and dark
                        mode without any theme-aware classes.

                        The brand mark sits directly on the grid as the
                        same blue Hippius logo the top bar uses — never on
                        a filled blue badge. The solid-blue badge is
                        reserved for the bridge dialog and the OS tray
                        icon; every other surface shows this bare mark. */}
                    <div className="relative flex size-14 items-center justify-center">
                      <Icons.Decoration className="absolute inset-0 size-full" />
                      <HippiusLogo className="relative size-8" />
                    </div>

                    {/* Pill + title + subtitle — crossfaded as a unit
                        on each state change. Keying by status means
                        all three swap together so the header reads as
                        one beat instead of three independent flickers. */}
                    <div className="flex w-full flex-col items-center gap-[8px] text-center">
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={effectiveStatus}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          transition={{ duration: 0.25, ease: "easeOut" }}
                          className="flex w-full flex-col items-center gap-[8px]"
                        >
                          <StatePill status={effectiveStatus} />
                          <h1 className="max-w-[320px] text-[24px] font-medium leading-[32px] text-black-700 dark:text-grey-light-100">
                            {title}
                          </h1>
                          {effectiveStatus === "available" && (
                            <p className="text-[15px] font-medium leading-[22px] tracking-[-0.30px] text-grey-50 dark:text-grey-dark-500">
                              {installPlan.kind === "manual"
                                ? installPlan.hint
                                : `Install Version ${effectiveUpdate?.version} now`}
                            </p>
                          )}
                          {effectiveStatus === "no-update" && (
                            <p className="text-[15px] font-medium leading-[22px] tracking-[-0.30px] text-grey-50 dark:text-grey-dark-500">
                              Check again later to stay current.
                            </p>
                          )}
                          {effectiveStatus === "error" && (
                            <p className="text-[15px] font-medium leading-[22px] tracking-[-0.30px] text-grey-50 dark:text-grey-dark-500">
                              {errorDetail || UPDATE_FAILED_FALLBACK}
                            </p>
                          )}
                          {effectiveStatus === "checking" && (
                            <p className="text-[15px] font-medium leading-[22px] tracking-[-0.30px] text-grey-50 dark:text-grey-dark-500">
                              Please wait a moment…
                            </p>
                          )}
                        </motion.div>
                      </AnimatePresence>
                    </div>
                  </div>

                  {/* Per-state body — wrapped in AnimatePresence so the
                      content crossfades when the lifecycle advances
                      (checking → available → downloading → installing
                      → complete). `mode="wait"` keeps card height
                      jitter-free by waiting for the outgoing block to
                      finish before the incoming block enters. */}
                  <AnimatePresence mode="wait" initial={false}>
                    {effectiveStatus === "checking" && (
                      <motion.div
                        key="checking"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.25, ease: "easeOut" }}
                        className="flex w-full items-center justify-center"
                        role="status"
                        aria-live="polite"
                      >
                        <span
                          aria-hidden="true"
                          className="inline-block size-8 rounded-full border-2 border-grey-90 border-t-primary-50 animate-spin dark:border-black-300 dark:border-t-primary-65"
                        />
                      </motion.div>
                    )}

                    {effectiveStatus === "available" &&
                      effectiveUpdate?.notes && (
                        <motion.div
                          key="release-notes"
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -6 }}
                          transition={{ duration: 0.25, ease: "easeOut" }}
                          className="flex w-full flex-col gap-[12px]"
                        >
                          <div className="flex items-center gap-[8px]">
                            <Icons.Note2 className="size-5 text-warning-50" />
                            <span className="text-[16px] font-semibold leading-[22px] tracking-[-0.32px] text-grey-10 dark:text-white">
                              Release Notes
                            </span>
                          </div>
                          <div className="max-h-[200px] overflow-y-auto pr-1 text-[14px] leading-[20px] tracking-[-0.28px] text-grey-50 dark:text-grey-dark-500">
                            <BasicMarkdown text={effectiveUpdate.notes} />
                          </div>
                        </motion.div>
                      )}

                    {(effectiveStatus === "downloading" ||
                      effectiveStatus === "installing") && (
                      <motion.div
                        key="progress"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.25, ease: "easeOut" }}
                        className="flex w-full flex-col gap-[10px]"
                      >
                        <div className="flex items-center justify-between text-[14px] font-medium tracking-[-0.28px]">
                          <AnimatePresence mode="wait" initial={false}>
                            <motion.span
                              key={effectiveStatus}
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -4 }}
                              transition={{ duration: 0.18, ease: "easeOut" }}
                              className="text-grey-10 dark:text-white"
                            >
                              {effectiveStatus === "downloading"
                                ? "Downloading"
                                : "Installing"}
                            </motion.span>
                          </AnimatePresence>
                          <span className="text-primary-50 tabular-nums">
                            {Math.round(smoothProgress)}%
                          </span>
                        </div>
                        <ProgressBar progress={smoothProgress} />
                        {effectiveStatus === "downloading" &&
                          effectiveTotalBytes > 0 && (
                            <p className="text-[12px] tabular-nums tracking-[-0.24px] text-grey-60 dark:text-grey-dark-600">
                              {formatBytes(smoothBytes)} MB /{" "}
                              {formatBytes(effectiveTotalBytes)} MB
                            </p>
                          )}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* CTA — project Button primary variant. The shared
                      component handles corner-dot decoration, hover, and
                      a11y; we just pin the 52px height per the Figma.
                      Crossfaded so it gracefully appears/disappears as
                      the dialog walks through states without a CTA
                      (checking, downloading, installing). */}
                  <AnimatePresence mode="wait" initial={false}>
                    {cta && (
                      <motion.div
                        key={cta.label}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.25, ease: "easeOut" }}
                      >
                        <Button
                          type="button"
                          onClick={cta.onClick}
                          variant="primary"
                          size="auto"
                          className="h-[52px] w-full rounded-[6px] px-4 text-[16px] font-medium tracking-[-0.32px]"
                        >
                          {cta.label}
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Version footer — always shown. */}
                  <p className="text-center text-[12px] font-medium leading-[18px] tracking-[-0.24px] text-grey-dark-600 dark:text-[#a3a3a3]">
                    Version{" "}
                    {effectiveUpdate?.version ||
                      effectiveCurrentVersion ||
                      "—"}
                  </p>
                </div>
              </motion.div>
            </div>
          </main>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
