"use client";

import { useEffect, useId, useRef } from "react";
import { Sparkles, Video } from "lucide-react";

import { GLASS_BUTTON, GLASS_MUTED, GLASS_PANEL, GLASS_PANEL_TIGHT, GLASS_PRIMARY } from "@/app/lib/capture/glass";
import { RECORDING_LIMIT_BODY, RECORDING_LIMIT_TITLE } from "@/app/lib/capture/recordingLimit";

/**
 * The capture bar's answer to a refused Record: the free plan's recordings
 * are used up (Rust's `RECORDING_LIMIT_REACHED`, decided before anything
 * recorded). The same words and ways out as the main window's dialog, on
 * the bar's glass, so the user never leaves what they were doing to read
 * it. Upgrade closes the bar and opens the plans (Rust's
 * `capture_limit_upgrade`); Not now closes this and leaves the bar up, so a
 * screenshot can still be taken.
 *
 * On the overlay it sits centred over the screen; in Wayland's panel
 * (`inline`) it is in the panel's flow under the bar, so the fitted window
 * grows to hold it. The page skips its own keys while this is open; Escape
 * here is Not now.
 */
export default function RecordingLimitPanel({
  onUpgrade,
  onClose,
  inline = false,
}: {
  onUpgrade: () => void;
  onClose: () => void;
  inline?: boolean;
}) {
  const titleId = useId();
  const bodyId = useId();
  const upgradeRef = useRef<HTMLButtonElement>(null);
  // The latest Not now, so the listener below is bound once and focus is
  // put on Upgrade once, not again on every render of the page.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    upgradeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    // Capture phase: ahead of the page's own Escape, which cancels the capture.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const panel = (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="recording-limit-panel"
      className={`w-[min(360px,calc(100vw-32px))] rounded-[14px] p-4 ${inline ? GLASS_PANEL_TIGHT : GLASS_PANEL}`}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/10">
          <Video aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id={titleId} className="text-[14px] font-semibold leading-5">
            {RECORDING_LIMIT_TITLE}
          </h2>
          <p id={bodyId} className={`mt-1 text-[13px] leading-5 ${GLASS_MUTED}`}>
            {RECORDING_LIMIT_BODY}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className={`h-8 whitespace-nowrap rounded-[8px] px-3 text-[13px] ${GLASS_BUTTON}`}>
          Not now
        </button>
        <button
          ref={upgradeRef}
          type="button"
          onClick={onUpgrade}
          className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] ${GLASS_PRIMARY}`}
        >
          <Sparkles aria-hidden className="size-3.5" /> Upgrade
        </button>
      </div>
    </div>
  );

  if (inline) return <div className="mt-2">{panel}</div>;
  return (
    // Covers the selection surface, so nothing behind the panel is chosen
    // while it is up.
    <div
      className="fixed inset-0 z-50 grid place-items-center px-4"
      style={{ cursor: "default" }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
    >
      {panel}
    </div>
  );
}
