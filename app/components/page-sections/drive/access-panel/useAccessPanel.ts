"use client";

// The Manage access panel's data: one Rust fold (`list_access_panel`), loaded
// when the panel opens and read again after anything changes. Rows never show
// a change until Rust has made it and the listing has been read again.

import { useCallback, useEffect, useRef, useState } from "react";
import { isSharedDrivesUnavailable, type AccessPanel, type DriveTarget } from "@/app/lib/tauri/sharedDrives";
import { errorMessage } from "@/lib/utils/errorUtils";
import type { ShareAccessApi } from "../share-dialog/shareAccessApi";

export type AccessPanelState =
  | { kind: "loading" }
  | { kind: "ready"; panel: AccessPanel }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function useAccessPanel(params: {
  api: ShareAccessApi;
  label: string;
  /** Present for a folder. */
  pathPrefix: string | null;
  target?: DriveTarget;
}): {
  state: AccessPanelState;
  /** Read the listing again, keeping the rows on screen meanwhile. */
  reload: () => Promise<void>;
  /** Start over from the skeleton, after a failed first load. */
  retry: () => void;
} {
  const { api, label, pathPrefix, target } = params;
  const [state, setState] = useState<AccessPanelState>({ kind: "loading" });
  // Only the newest request may land: the panel reloads after every change,
  // and an older answer arriving late would put a removed row back.
  const seq = useRef(0);

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++seq.current;
      if (!quiet) setState({ kind: "loading" });
      try {
        const panel = await api.listPanel(label, pathPrefix, target);
        if (mine === seq.current) setState({ kind: "ready", panel });
      } catch (err) {
        if (mine !== seq.current) return;
        // A failed refresh keeps the rows already on screen.
        if (quiet) return;
        setState(
          isSharedDrivesUnavailable(err) ? { kind: "unavailable" } : { kind: "error", message: errorMessage(err) },
        );
      }
    },
    [api, label, pathPrefix, target],
  );

  useEffect(() => {
    void load(false);
    // Bumping the counter on cleanup drops a late answer for a closed or
    // retargeted panel.
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  const retry = useCallback(() => void load(false), [load]);
  return { state, reload, retry };
}
