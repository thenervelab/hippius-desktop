"use client";

import { FC, useEffect, useState, useRef, useMemo } from "react";
import { useAtomValue } from "jotai";
import {
  driveStatusesAtom,
  driveStatusesLoadedAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";

interface SyncFolderSelectProps {
  value: string | null;
  onChange: (label: string, path: string) => void;
  defaultLabel?: string | null;
  className?: string;
}

interface SyncFolderOption {
  label: string;
  path: string;
}

const SyncFolderSelect: FC<SyncFolderSelectProps> = ({
  value,
  onChange,
  defaultLabel,
  className,
}) => {
  // Read configured drives from the per-drive status atom (single source
  // of truth, hydrated by `useDriveStatuses`). No DB round-trip needed —
  // every entry already carries `label + path`.
  const driveStatuses = useAtomValue(driveStatusesAtom);
  const driveStatusesLoaded = useAtomValue(driveStatusesLoadedAtom);
  const syncPaths = useMemo<SyncFolderOption[]>(
    () =>
      Array.from(driveStatuses.entries())
        .filter(([, entry]) => !!entry.path)
        .map(([label, entry]) => ({ label, path: entry.path })),
    [driveStatuses]
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
    if (match?.path) {
      onChange(match.label, match.path);
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
      <label className="text-sm font-medium text-grey-50">
        Upload to folder
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex w-full justify-between cursor-pointer items-center gap-2 px-4 h-[3rem] text-sm font-medium border border-grey-80 rounded-lg text-grey-10 bg-grey-100 focus:outline-none"
        >
          <span className="truncate">{selectedLabel ?? "Select folder"}</span>
          <Icons.ChevronDown
            className={cn(
              "h-5 w-5 text-grey-50 shrink-0 transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 overflow-hidden rounded-lg bg-white shadow-lg border border-grey-80 z-[100]">
            <div className="p-1.5 max-h-60 overflow-auto flex flex-col gap-0.5">
              {syncPaths.map((sp) => {
                const isSelected = sp.label === value;
                return (
                  <div
                    key={sp.label}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(sp.label, sp.path);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-center px-3 py-2.5 text-sm cursor-pointer text-grey-10 transition-colors duration-150 select-none rounded-md hover:bg-grey-90 truncate",
                      isSelected ? "bg-grey-80 font-medium" : "",
                    )}
                    title={sp.label}
                  >
                    {sp.label}
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
