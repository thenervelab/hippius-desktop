"use client";

import { FC, useEffect, useState } from "react";
import { getAllSyncPaths, SyncPathResult } from "@/lib/utils/syncPathUtils";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { cn } from "@/lib/utils";
import * as RadixSelect from "@radix-ui/react-select";
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
      <RadixSelect.Root
        value={value ?? ""}
        onValueChange={(val) => {
          const selected = syncPaths.find((sp) => sp.label === val);
          if (selected) {
            onChange(selected.label, selected.path);
          }
        }}
      >
        <RadixSelect.Trigger
          className={cn(
            "flex justify-between cursor-pointer group items-center gap-2 px-3 py-2 h-10 text-sm font-medium border border-grey-80 rounded text-grey-10 bg-white focus:outline-none focus:ring-2 focus:ring-primary-50 hover:border-primary-60 transition-colors w-full",
          )}
          aria-label="Upload to folder"
        >
          <RadixSelect.Value placeholder="Select folder" />
          <RadixSelect.Icon className="h-4 w-4 text-grey-40">
            <Icons.ChevronDown className="transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            side="bottom"
            position="popper"
            sideOffset={4}
            avoidCollisions={true}
            className="mt-1 overflow-hidden rounded-md bg-white shadow-lg border border-grey-80 z-[100] w-[var(--radix-select-trigger-width)]"
          >
            <RadixSelect.Viewport className="py-1 max-h-60 overflow-auto">
              {syncPaths.map((sp) => {
                const isSelected = sp.label === value;
                return (
                  <RadixSelect.Item
                    key={sp.label}
                    value={sp.label}
                    className={cn(
                      "flex items-center px-3 py-2 text-sm cursor-pointer text-grey-10 hover:bg-grey-95 focus:bg-grey-95 transition-colors duration-150 focus:outline-none select-none data-[highlighted]:bg-grey-95",
                      isSelected ? "bg-grey-95 font-medium" : "bg-white",
                    )}
                  >
                    <RadixSelect.ItemText>{sp.label}</RadixSelect.ItemText>
                  </RadixSelect.Item>
                );
              })}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
    </div>
  );
};

export default SyncFolderSelect;
