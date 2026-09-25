"use client";

// Change which folders a holder has, from the Manage access panel's row menu.
// A view inside the panel, in place of its list, never a second dialog over
// it (the panel is itself a dialog on a narrow window).

import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui";
import Input from "@/components/ui/input";
import { Select } from "@/components/ui/select/Select";
import { SectionNoticeView } from "../share-dialog/SectionNoticeView";
import { useEscapeFirst } from "../share-dialog/RowConfirm";
import { noticeForError, type SectionNotice } from "../share-dialog/shareDialogState";
import { driveRoleLabel, type DriveRole } from "@/app/lib/shared-drives/roles";
import { FOLDER_INVITE_ROLES } from "../shareDriveModalState";

/** Viewer or Editor: the roles a folder can be granted with. */
export type FolderRole = Exclude<DriveRole, "manager">;

/** Replace a holder's folders; `role` applies to folders being added. */
export type ChangeGrantFolders = (memberSs58: string, folders: string[], role?: FolderRole) => Promise<void>;

/**
 * Change which folders a holder has: untick to take one away, or add a
 * folder with Viewer or Editor access. At least one must stay: removing every
 * folder is Remove access, a different request. The folder path is checked
 * by Rust on Save (the same rule a folder invite uses), and a refusal stays
 * in the view with the reason. Back, Cancel and Escape return to the list.
 */
export default function ChangeFoldersView({
  who,
  folders,
  onClose,
  onConfirm,
}: {
  who: string;
  folders: string[];
  onClose: () => void;
  onConfirm: (next: string[], addRole?: FolderRole) => Promise<void>;
}) {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set(folders));
  const [added, setAdded] = useState("");
  const [addRole, setAddRole] = useState<FolderRole>("reader");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  const adding = added.trim().length > 0;
  const next = [...folders.filter((f) => kept.has(f)), ...(adding ? [added.trim()] : [])];
  const unchanged = !adding && kept.size === folders.length;
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The view replaces the list the row was in, so focus starts on its title.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);
  useEscapeFirst(rootRef, onClose);

  const save = async (role: FolderRole) => {
    setSaving(true);
    setNotice(null);
    try {
      await onConfirm(next, adding ? role : undefined);
      onClose();
    } catch (err) {
      setNotice(noticeForError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section ref={rootRef} aria-labelledby="change-folders-heading" className="font-geist">
      <div className="-mx-4 mb-3 flex min-w-0 items-center gap-2 border-b border-grey-80 px-4 pb-2.5 pt-2 dark:border-white/10">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md py-1 pl-0.5 pr-1.5 text-xs font-medium text-primary-50 hover:bg-grey-90/60 dark:text-primary-brand-dark dark:hover:bg-white/5"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Back
        </button>
        <h3
          id="change-folders-heading"
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 truncate text-sm font-semibold text-grey-10 outline-none dark:text-white"
        >
          Change folders
        </h3>
      </div>
      <div>
        <p className="mb-4 break-words text-sm text-grey-50 [overflow-wrap:anywhere] dark:text-grey-dark-600">
          Which folders {who} has access to.
        </p>
        <div className="mb-4 flex flex-col gap-2">
          {folders.map((folder) => (
            <label
              key={folder}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-grey-80 p-3 transition-colors hover:bg-grey-90 dark:border-white/10 dark:hover:bg-white/5"
            >
              <input
                type="checkbox"
                className="accent-primary-50"
                checked={kept.has(folder)}
                onChange={(e) =>
                  setKept((prev) => {
                    const nextSet = new Set(prev);
                    if (e.target.checked) nextSet.add(folder);
                    else nextSet.delete(folder);
                    return nextSet;
                  })
                }
              />
              <span className="min-w-0 truncate text-sm text-grey-10 dark:text-white" title={folder}>
                {folder}
              </span>
            </label>
          ))}
        </div>

        <div className="mb-4">
          <p className="mb-1.5 text-xs font-medium text-grey-10 dark:text-white">Add a folder</p>
          <div className="flex flex-col gap-2 @[300px]:flex-row">
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Folder to add"
                placeholder="Clients/ACME"
                value={added}
                onChange={(e) => {
                  setAdded(e.target.value);
                  setNotice(null);
                }}
                wrapperClassName="min-h-[40px] py-2 sm:min-h-[40px]"
                className="text-sm"
              />
            </div>
            <Select
              ariaLabel="Access to the added folder"
              value={addRole}
              onValueChange={(value) => {
                setAddRole(value as FolderRole);
                setNotice((n) => (n?.kind === "folderEditor" ? null : n));
              }}
              options={FOLDER_INVITE_ROLES.map((r) => ({ label: driveRoleLabel(r), value: r }))}
              className="@[300px]:w-[116px] @[300px]:shrink-0"
              triggerClassName="min-h-[40px] py-2 sm:min-h-[40px] px-3"
              valueClassName="text-sm"
            />
          </div>
          <p className="mt-1.5 text-xs text-grey-50 dark:text-grey-dark-600">
            A path inside the drive. Folders they already have keep their access.
          </p>
        </div>

        {next.length === 0 && (
          <p className="mb-4 text-xs text-grey-50 dark:text-grey-dark-600">
            Keep at least one folder. To take everything away, use Remove access instead.
          </p>
        )}
        {notice ? (
          <SectionNoticeView
            notice={notice}
            viewOnlyLabel="Add as view only"
            onViewOnly={() => {
              setAddRole("reader");
              void save("reader");
            }}
            onUpgrade={onClose}
            className="mb-4"
          />
        ) : null}

        <div className="flex flex-col gap-3">
          <Button
            type="button"
            variant="primary"
            size="auto"
            disabled={saving || next.length === 0 || unchanged}
            onClick={() => void save(addRole)}
            className="h-[38px] w-full rounded-[8px] text-[14px] font-medium leading-[1.4] tracking-[-0.28px]"
          >
            {saving ? "Saving…" : "Save folders"}
          </Button>
          <Button
            type="button"
            variant="defaultStable"
            size="auto"
            onClick={onClose}
            className="h-[38px] w-full rounded-[8px] border border-grey-80 text-[14px] font-medium leading-[1.4] tracking-[-0.28px] text-grey-10 dark:border-white/10 dark:text-white"
          >
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}
