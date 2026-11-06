"use client";

import { useEffect, useRef } from "react";

import { claimOsDrops, registerOsDropTarget, type OsDropTarget } from "./osDrop";

/**
 * Say where a drop on this view goes, for as long as the view is mounted.
 * `null` takes no drops (the registration below it answers instead).
 *
 * Registered once per mount and read through a ref at drag time, so a
 * view that moves between folders never re-registers and a drop always
 * meets the folder on screen.
 */
export function useOsDropTarget(target: OsDropTarget | null): void {
  const ref = useRef(target);
  ref.current = target;
  useEffect(() => registerOsDropTarget(() => ref.current), []);
}

/**
 * Hold the page's drop handling off while a dialog with its own drop area
 * is open, so one drop is not handled twice.
 */
export function useClaimOsDrops(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return claimOsDrops();
  }, [active]);
}
