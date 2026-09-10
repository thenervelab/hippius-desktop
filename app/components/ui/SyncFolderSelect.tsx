"use client";

import { FC, useEffect, useState, useRef, useMemo } from "react";
import { useAtomValue } from "jotai";
import {
  driveStatusesAtom,
  driveStatusesLoadedAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";
import { listRemoteFolders } from "@/app/lib/utils/restoreUtils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";

/** Drives on the account that this computer does not sync. */
export const REMOTE_UPLOAD_TARGETS_QUERY_KEY = "remoteUploadTargets";

interface SyncFolderSelectProps {
  value: string | null;
  /**
   * `path` is empty for a drive that is not synced on this computer, and
   * `remote` says so explicitly rather than leaving the caller to infer it
   * from the empty string — an upload routed to the wrong side either
   * lands in the wrong drive or fails.
   */
  onChange: (label: string, path: string, remote: boolean) => void;
  defaultLabel?: string | null;
  className?: string;
  /**
   * Whether drives that are NOT synced on this computer are offered.
   *
   * They upload straight to the server, so the destination is real — but
   * only where the caller can actually route there.
   */
  includeRemote?: boolean;
}

interface SyncFolderOption {
  label: string;
  path: string;
  remote: boolean;
}

const SyncFolderSelect: FC<SyncFolderSelectProps> = ({
  value,
  onChange,
  defaultLabel,
  className,
  includeRemote = false,
}) => {
  // Read configured drives from the per-drive status atom (single source
  // of truth, hydrated by `useDriveStatuses`). No DB round-trip needed —
  // every entry already carries `label + path`.
  const driveStatuses = useAtomValue(driveStatusesAtom);
  const driveStatusesLoaded = useAtomValue(driveStatusesLoadedAtom);
  const { polkadotAddress } = useWalletAuth();
  const localPaths = useMemo<SyncFolderOption[]>(
    () =>
      Array.from(driveStatuses.entries())
        .filter(([, entry]) => !!entry.path)
        .map(([label, entry]) => ({ label, path: entry.path, remote: false })),
    [driveStatuses]
  );

  // Drives that exist on the account but are not synced here have no local
  // path, so they are absent from the drive-status map entirely. They are
  // still valid upload destinations — the files go straight to the server
  // — so they are fetched separately and listed under their own heading.
  const { data: remoteFolders } = useQuery({
    queryKey: [REMOTE_UPLOAD_TARGETS_QUERY_KEY, polkadotAddress],
    queryFn: () => listRemoteFolders(polkadotAddress as string),
    enabled: includeRemote && Boolean(polkadotAddress),
    staleTime: 60_000,
  });

  const remotePaths = useMemo<SyncFolderOption[]>(() => {
    if (!includeRemote || !remoteFolders) return [];
    const local = new Set(localPaths.map((p) => p.label));
    return remoteFolders
      .map((f) => f.label)
      // A drive synced here appears in the local list already; listing it
      // twice would offer the same drive by two different routes.
      .filter((label) => label.length > 0 && !local.has(label))
      .map((label) => ({ label, path: "", remote: true }));
  }, [includeRemote, remoteFolders, localPaths]);

  const syncPaths = useMemo<SyncFolderOption[]>(
    () => [...localPaths, ...remotePaths],
    [localPaths, remotePaths],
  );

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve initial selection: prefer the controlled `value`, then
  // `defaultLabel`, then the first drive. Runs whenever the drive list
  // or controlled value changes.
  useEffect(() => {
    if (!driveStatusesLoaded || syncPaths.length === 0) return;
    const match = value
      ? syncPaths.find((sp) => sp.label === value)
      : (syncPaths.find((sp) => sp.label === defaultLabel) ?? syncPaths[0]);
    // A remote drive has no path, so `match.path` cannot be the guard —
    // that is what kept remote destinations from ever being selected.
    if (match) {
      onChange(match.label, match.path, match.remote);
    }
    // `onChange` is intentionally excluded — callers commonly pass
    // inline functions and we don't want to thrash the selection on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveStatusesLoaded, syncPaths, value, defaultLabel]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!driveStatusesLoaded || syncPaths.length < 2) return null;

  const selectedLabel = syncPaths.find((sp) => sp.label === value)?.label;

  return (
    <div className={cn("flex flex-col gap-1.5", className)} ref={containerRef}>
      <label className="text-sm font-medium text-grey-50 dark:text-grey-dark-700">
        Upload to folder
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex w-full justify-between cursor-pointer items-center gap-2 px-4 h-[3rem] text-sm font-medium border border-grey-80 rounded-lg text-grey-10 bg-grey-100 focus:outline-none dark:border-[#494949] dark:bg-[#1f1f1f] dark:text-white dark:hover:bg-[#252525]"
        >
          <span className="truncate">{selectedLabel ?? "Select folder"}</span>
          <Icons.ChevronDown
            className={cn(
              "h-5 w-5 text-grey-50 shrink-0 transition-transform duration-200 dark:text-[#7d7d7d]",
              open && "rotate-180"
            )}
          />
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 overflow-hidden rounded-lg bg-white shadow-lg border border-grey-80 z-[100] dark:bg-[#1f1f1f] dark:border-[#494949]">
            <div className="p-1.5 max-h-60 overflow-auto flex flex-col gap-0.5">
              {syncPaths.map((sp) => {
                const isSelected = sp.label === value;
                return (
                  <div
                    key={sp.label}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(sp.label, sp.path, sp.remote);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-center justify-between px-3 py-2.5 text-sm cursor-pointer text-grey-10 transition-colors duration-150 select-none rounded-md hover:bg-grey-90 truncate dark:text-[#a3a3a3] dark:hover:bg-[#2c2c2c] dark:hover:text-white",
                      isSelected
                        ? "bg-grey-80 font-medium dark:bg-[#2c2c2c] dark:text-white"
                        : "",
                    )}
                    title={sp.remote ? `${sp.label} — not synced on this computer` : sp.label}
                  >
                    <span className="truncate">{sp.label}</span>
                    {sp.remote && (
                      <span className="ml-2 shrink-0 text-[11px] font-medium text-grey-60 dark:text-grey-dark-600">
                        Not synced here
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SyncFolderSelect;
