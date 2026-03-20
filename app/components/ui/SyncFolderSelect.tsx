"use client";

import { FC, useEffect, useState, useRef } from "react";
import { getAllSyncPaths, SyncPathResult } from "@/lib/utils/syncPathUtils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/lib/utils";
import { Icons } from "@/components/ui";

interface SyncFolderSelectProps {
  value: string | null;
  onChange: (label: string, path: string) => void;
  defaultLabel?: string | null;
  className?: string;
}

const SyncFolderSelect: FC<SyncFolderSelectProps> = ({
  value,
  onChange,
  defaultLabel,
  className,
}) => {
  const { polkadotAddress } = useWalletAuth();
  const [syncPaths, setSyncPaths] = useState<SyncPathResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const paths = await getAllSyncPaths(polkadotAddress || undefined);
        setSyncPaths(paths.filter((sp) => !!sp.path));

        if (paths.length > 0) {
          // If a value is already set (e.g. from the selected tab), resolve its path.
          // Otherwise fall back to defaultLabel or the first folder.
          const match = value
            ? paths.find((sp) => sp.label === value)
            : (paths.find((sp) => sp.label === defaultLabel) ?? paths[0]);
          if (match?.path) {
            onChange(match.label, match.path);
          }
        }
      } catch {
        console.error("Failed to load sync paths");
      } finally {
        setLoading(false);
      }
    })();
    // Only run on mount and when account changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polkadotAddress]);

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

  if (loading || syncPaths.length < 2) return null;

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
          className="flex w-full justify-between cursor-pointer items-center gap-2 px-4 h-[48px] text-sm font-medium border border-grey-80 rounded-lg text-grey-10 bg-grey-100 focus:outline-none"
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
          <div className="absolute left-0 right-0 top-full mt-1 overflow-hidden rounded-lg bg-grey-100 shadow-lg border border-grey-80 z-[100]">
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
                      "flex items-center px-3 py-2.5 text-sm cursor-pointer text-grey-10 transition-colors duration-150 select-none rounded-md hover:bg-grey-90",
                      isSelected ? "bg-grey-80 font-medium" : "",
                    )}
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
