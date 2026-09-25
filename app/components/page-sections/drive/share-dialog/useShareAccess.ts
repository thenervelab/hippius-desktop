"use client";

// The Share dialog's "People with access" data: one Rust fold
// (`list_share_access`), loaded when the dialog opens and again after
// anything the dialog changes. Changes are not shown until Rust has made them
// and the listing has been read again, so a row never claims a role the
// server refused.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSharedDrivesUnavailable,
  listShareAccess,
  type DriveTarget,
  type ShareAccess,
} from "@/app/lib/tauri/sharedDrives";
import { errorMessage } from "@/lib/utils/errorUtils";

export type ShareAccessState =
  | { kind: "loading" }
  | { kind: "ready"; access: ShareAccess }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function useShareAccess(params: {
  label: string;
  /** Present for a folder. */
  pathPrefix: string | null;
  target?: DriveTarget;
}): {
  state: ShareAccessState;
  /** Read the listing again, keeping the rows on screen meanwhile. */
  reload: () => Promise<void>;
  /** Start over from the skeleton, after a failed first load. */
  retry: () => void;
} {
  const { label, pathPrefix, target } = params;
  const [state, setState] = useState<ShareAccessState>({ kind: "loading" });
  // Only the newest request may land: the dialog reloads after every change,
  // and an older answer arriving late would put a removed row back.
  const seq = useRef(0);

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++seq.current;
      if (!quiet) setState({ kind: "loading" });
      try {
        const access = await listShareAccess(label, pathPrefix, target);
        if (mine === seq.current) setState({ kind: "ready", access });
      } catch (err) {
        if (mine !== seq.current) return;
        // A failed refresh keeps the rows already on screen.
        if (quiet) return;
        setState(
          isSharedDrivesUnavailable(err) ? { kind: "unavailable" } : { kind: "error", message: errorMessage(err) },
        );
      }
    },
    [label, pathPrefix, target],
  );

  useEffect(() => {
    void load(false);
    // The counter itself, not a value read from it: bumping it on cleanup is
    // what drops a late answer for a closed or retargeted dialog.
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  const retry = useCallback(() => void load(false), [load]);

  return { state, reload, retry };
}
