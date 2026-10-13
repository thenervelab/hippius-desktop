import { useEffect, useState } from "react";
import { getFreePlanNotice, type FreePlanNotice } from "@/app/lib/tauri/capture";

/**
 * The free plan's notice before a capture, worded from Rust's numbers
 * (`capture_free_plan_notice`). Rust decides who is on the free plan and
 * what is counted; a paid plan, or one that cannot be read, gets no notice.
 */

/** "3 of 25 free recordings used", or null when the count is unknown. */
export function freeRecordingsUsed(notice: FreePlanNotice): string | null {
  return notice.used === null ? null : `${notice.used} of ${notice.limit} free recordings used`;
}

/**
 * The capture bar's line. Recording facts are left out where this computer
 * cannot record.
 */
export function freePlanBarLine(notice: FreePlanNotice, recordingAvailable: boolean): string {
  if (!recordingAvailable) return "Free plan: captures carry a small Hippius watermark.";
  const used = freeRecordingsUsed(notice);
  const facts = `Free plan: captures carry a small Hippius watermark and recordings stop at ${notice.maxRecordingMins} minutes.`;
  return used ? `${facts} ${used}.` : facts;
}

/** Ask Rust once on mount; null until it answers, and for anyone not on the free plan. */
export function useFreePlanNotice(): FreePlanNotice | null {
  const [notice, setNotice] = useState<FreePlanNotice | null>(null);
  useEffect(() => {
    let live = true;
    getFreePlanNotice()
      .then((next) => {
        if (live) setNotice(next ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return notice;
}
