"use client";

import { useAtomValue } from "jotai";
import { toast } from "sonner";
import { driveTrashEnabledAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { useSkipTrash } from "@/app/lib/trash/deleteMode";
import { SettingsCard } from "./SettingsCard";
import { SettingsToggle } from "./SettingsToggle";

/**
 * "Skip Trash when deleting", per account, off by default. On, Delete
 * removes items for good and always asks first. Shown only while the
 * server keeps a Trash (`drive_trash`).
 */
export default function SkipTrashSetting() {
  const trashEnabled = useAtomValue(driveTrashEnabledAtom);
  const { skipTrash, loaded, setSkipTrash } = useSkipTrash();
  if (!trashEnabled) return null;
  return (
    <SettingsCard label="Drive">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p id="skip-trash-title" className="text-sm font-medium text-grey-10 dark:text-white">
            Skip Trash when deleting
          </p>
          <p className="mt-1 text-sm text-grey-60 dark:text-grey-70">
            Deleted items are removed for good, after you confirm.
          </p>
        </div>
        <div className="flex-shrink-0 pt-0.5">
          <SettingsToggle
            ariaLabel="Skip Trash when deleting"
            checked={skipTrash}
            disabled={!loaded}
            onCheckedChange={(value) =>
              void setSkipTrash(value).catch(() => toast.error("Couldn't save that."))
            }
          />
        </div>
      </div>
    </SettingsCard>
  );
}
