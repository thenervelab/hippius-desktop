// "Shared with me" — drives other accounts invited this one into, fed by
// `list_my_drive_memberships`. Rendered in BOTH MultiFolderSyncManager
// (settings) and DriveOnboarding (files page); flag-gated and silent in
// every non-rows state (see `sharedWithMeState.ts::getSharedWithMeView`):
// a feature-off server, a failed passive fetch, or zero memberships all
// render nothing — never a toast, never an empty headline.
//
// An unsynced row's "Sync locally" runs: folder picker (last-browse-dir
// chain) → `add_shared_drive` → the drive lands in the NORMAL lists,
// which are the management surface from then on (this section then shows
// the row as synced with its local label). A synced row deliberately has
// no actions here.

"use client";

import React, { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Users } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "../SettingsCard";
import { middleTruncate } from "@/lib/utils/middleTruncate";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import {
  addSharedDrive,
  isSharedDrivesUnavailable,
  listMyDriveMemberships,
  type DriveMembershipInfo,
} from "@/app/lib/tauri/sharedDrives";
import {
  getLastBrowseDirectory,
  saveLastBrowseDirectory,
} from "@/app/lib/utils/userPreferencesDb";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import {
  getMembershipRowAction,
  getSharedWithMeView,
  type SharedWithMeData,
} from "./sharedWithMeState";

const OwnerAvatar = dynamic(() => import("boring-avatars"), { ssr: false });

interface SharedWithMeSectionProps {
  /**
   * Fired after `add_shared_drive` succeeds with the allocated local
   * label — the parent refreshes its drive lists (and may navigate to
   * the new drive).
   */
  onDriveAdded?: (label: string) => void;
}

export function SharedWithMeSection({ onDriveAdded }: SharedWithMeSectionProps) {
  const [data, setData] = useState<SharedWithMeData>({ kind: "idle" });
  // The row whose add_shared_drive call is in flight, keyed by
  // `${ownerSs58}:${folderHash}` (the membership's wire identity).
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const memberships = await listMyDriveMemberships();
      setData({ kind: "ready", memberships });
    } catch (err) {
      if (isSharedDrivesUnavailable(err)) {
        setData({ kind: "unavailable" });
      } else {
        // Passive mount-time fetch: log, render nothing, never toast.
        console.error("Failed to load drive memberships:", err);
        setData({ kind: "error" });
      }
    }
  }, []);

  useEffect(() => {
    if (!SHARED_DRIVES_ENABLED) return;
    void load();
  }, [load]);

  const syncLocally = useCallback(
    async (membership: DriveMembershipInfo) => {
      const key = `${membership.ownerSs58}:${membership.folderHash}`;
      try {
        const defaultPath = await getLastBrowseDirectory();
        const picked = await openDialog({
          directory: true,
          multiple: false,
          title: `Select where to sync "${membership.displayLabel}"`,
          defaultPath,
        });
        if (typeof picked !== "string") return;
        await saveLastBrowseDirectory(picked);

        setBusyKey(key);
        const result = await addSharedDrive(
          membership.ownerSs58,
          membership.folderHash,
          picked,
          membership.displayLabel,
        );
        toast.success(`Started syncing "${result.label}"`);
        onDriveAdded?.(result.label);
        await load();
      } catch (err) {
        if (isSharedDrivesUnavailable(err)) {
          setData({ kind: "unavailable" });
        } else {
          // Verbatim: a Validation refusal names the existing label/path
          // ("already set up as ..."), which is exactly what the user
          // needs to find the drive.
          toast.error(errorMessage(err));
        }
      } finally {
        setBusyKey(null);
      }
    },
    [onDriveAdded, load],
  );

  if (getSharedWithMeView(SHARED_DRIVES_ENABLED, data) === "hidden") return null;
  const memberships = data.kind === "ready" ? data.memberships : [];

  return (
    <SettingsCard label="Shared with Me" icon={<Users className="size-4" />}>
      <div className="max-h-[420px] overflow-y-auto">
        {memberships.map((membership) => {
          const key = `${membership.ownerSs58}:${membership.folderHash}`;
          const action = getMembershipRowAction(membership);
          return (
            <div key={key} className="flex items-center justify-between gap-3 p-3 hover:bg-grey-light-400 dark:hover:bg-white/5">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="size-[28px] shrink-0 overflow-hidden rounded-full">
                  <OwnerAvatar name={membership.ownerSs58} size={28} variant="pixel" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-grey-10 dark:text-white" title={membership.displayLabel}>
                    {membership.displayLabel}
                  </p>
                  <p
                    className="truncate font-mono text-[11px] text-grey-50 dark:text-grey-dark-600"
                    title={membership.ownerSs58}
                  >
                    {middleTruncate(membership.ownerSs58, 22)} · {membership.role}
                  </p>
                </div>
              </div>

              {action.kind === "synced" ? (
                <span className="shrink-0 text-xs font-medium text-[#04c870]">
                  Synced as &quot;{action.localLabel}&quot;
                </span>
              ) : (
                <Button
                  variant="defaultStable"
                  size="auto"
                  disabled={busyKey !== null}
                  loading={busyKey === key}
                  onClick={() => void syncLocally(membership)}
                  className={cn(
                    "h-[30px] shrink-0 gap-[7px] rounded-[6px] border px-3 text-[13px] font-normal",
                    "border-grey-dark-100 bg-[#FEFEFE] text-[#111]",
                    "hover:bg-[#F5F5F5]",
                    "dark:border-black-300 dark:bg-black-600 dark:text-grey-dark-300 dark:hover:bg-black-500",
                  )}
                >
                  {busyKey === key ? "Setting up…" : "Sync locally"}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}
