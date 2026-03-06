"use client";

import { FC, useEffect, useState } from "react";
import { getAllSyncPaths, SyncPathResult } from "@/lib/utils/syncPathUtils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

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

  useEffect(() => {
    (async () => {
      try {
        const paths = await getAllSyncPaths(polkadotAddress || undefined);
        setSyncPaths(paths.filter((sp) => !!sp.path));

        if (paths.length > 0 && !value) {
          const defaultPath =
            paths.find((sp) => sp.label === defaultLabel) ?? paths[0];
          if (defaultPath?.path) {
            onChange(defaultPath.label, defaultPath.path);
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

  if (loading || syncPaths.length < 2) return null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label className="text-sm font-medium text-grey-50">
        Upload to folder
      </label>
      <div className="relative">
        <select
          value={value ?? ""}
          onChange={(e) => {
            const selected = syncPaths.find(
              (sp) => sp.label === e.target.value
            );
            if (selected) {
              onChange(selected.label, selected.path);
            }
          }}
          className={cn(
            "w-full appearance-none rounded-lg border border-grey-80 bg-white",
            "px-3 py-2 pr-8 text-sm text-grey-20 font-medium",
            "focus:outline-none focus:ring-2 focus:ring-primary-50",
            "cursor-pointer hover:border-primary-60 transition-colors"
          )}
        >
          {syncPaths.map((sp) => (
            <option key={sp.label} value={sp.label}>
              {sp.label}
            </option>
          ))}
        </select>
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 size-4 text-grey-60 pointer-events-none" />
      </div>
    </div>
  );
};

export default SyncFolderSelect;
