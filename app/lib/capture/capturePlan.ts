import { useCallback, useEffect, useState } from "react";
import { onTauriEvent } from "@/app/lib/utils/tauriListeners";
import {
  CAPTURE_PLAN_CHANGED_EVENT,
  getCapturePlanStatus,
  retryCapturePlan,
  type CapturePlanStatus,
} from "@/app/lib/tauri/capture";

/**
 * The capture session's plan read, as Rust reports it
 * (`capture_plan_status`, then `capture_plan_changed`). Rust decides what
 * the plan allows and words every line; this only follows it.
 */

/** What the bar shows before Rust has answered: nothing can start yet. */
export const PLAN_UNKNOWN: CapturePlanStatus = { state: "checking", message: null, action: null };

/** Whether the bar's Capture / Record may be pressed. */
export function planAllowsCapture(status: CapturePlanStatus): boolean {
  return status.state === "ready";
}

/** Follow the plan read for as long as the bar is up; `retry` asks Rust to read it again. */
export function useCapturePlan(): { status: CapturePlanStatus; retry: () => void } {
  const [status, setStatus] = useState<CapturePlanStatus>(PLAN_UNKNOWN);
  useEffect(() => {
    let live = true;
    const unlisten = onTauriEvent<CapturePlanStatus>(CAPTURE_PLAN_CHANGED_EVENT, (e) => {
      if (live) setStatus(e.payload);
    });
    getCapturePlanStatus()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unlisten();
    };
  }, []);
  const retry = useCallback(() => {
    setStatus(PLAN_UNKNOWN);
    retryCapturePlan()
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  return { status, retry };
}
