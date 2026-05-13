"use client";

/**
 * TEMPORARY dev-only toggle for the Sync & Storage section.
 *
 * Lets you force the LocalFoldersSection and RemoteFoldersSection into
 * a forced "empty" or "loaded" mock state without having to wipe or
 * seed real sync folders. The choice is persisted in localStorage so
 * it survives reloads while iterating on the design.
 *
 * Removal when done: delete this file, drop the import + usage in
 * MultiFolderSyncManager (search for "_DevSyncStateToggle"), and
 * delete the `devOverride`/`useDevSyncOverride` plumbing in that
 * component.
 */

import { useCallback, useEffect, useState } from "react";

export type DevSyncOverride = "real" | "empty" | "loaded";

const STORAGE_KEY = "hippius_dev_sync_override";

export function useDevSyncOverride() {
  const [override, setOverrideState] = useState<DevSyncOverride>("real");

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    try {
      const v = window.localStorage.getItem(STORAGE_KEY) as DevSyncOverride | null;
      if (v === "empty" || v === "loaded") setOverrideState(v);
    } catch {
      // ignore
    }
  }, []);

  const setOverride = useCallback((next: DevSyncOverride) => {
    setOverrideState(next);
    try {
      if (next === "real") {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // ignore
    }
  }, []);

  return { override, setOverride };
}

interface Props {
  value: DevSyncOverride;
  onChange: (next: DevSyncOverride) => void;
}

export default function DevSyncStateToggle({ value, onChange }: Props) {
  if (process.env.NODE_ENV === "production") return null;

  const options: { value: DevSyncOverride; label: string }[] = [
    { value: "real", label: "Real" },
    { value: "empty", label: "Empty" },
    { value: "loaded", label: "Loaded" },
  ];

  return (
    <div className="fixed bottom-4 left-4 z-[100] flex items-center gap-1 rounded-md border border-[#3167dd] bg-white p-1 shadow-lg dark:bg-[#1a1a1a]">
      <span className="px-2 text-[10px] font-semibold uppercase tracking-wide text-[#7d7d7d]">
        Dev · Sync state
      </span>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={
              active
                ? "rounded px-2 py-1 text-[11px] font-medium bg-[#3167dd] text-white"
                : "rounded px-2 py-1 text-[11px] font-medium text-[#4F4F4F] hover:bg-[#f5f5f5] dark:text-grey-dark-300 dark:hover:bg-white/5"
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
