"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderPlus } from "lucide-react";

import { FramedDialog } from "@/components/ui/FramedDialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import SyncFolderSelect from "@/components/ui/SyncFolderSelect";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import {
  newFolderTargetAtom,
  type NewFolderTarget,
} from "@/app/lib/global-atoms/contextMenuAtoms";

/**
 * The one New Folder dialog, mounted once in `app/(pages)/layout.tsx`
 * beside the rename and share dialogs. Every surface opens it by setting
 * `newFolderTargetAtom`.
 *
 * It dispatches on the target's kind rather than being two dialogs: a
 * synced drive gets a real directory (`create_sync_folder`) and a browsed
 * one gets a registered folder entity (`create_remote_folder`). The name
 * is validated in Rust in both cases, so a failure shows the backend's
 * sentence rather than a second copy of the rules here.
 *
 * **When no folder is open it ASKS which drive**, through the app's own
 * `SyncFolderSelect` — the same picker the upload flows use, so a drive
 * is chosen the same way everywhere and remote drives come with it. An
 * earlier version defaulted to the main drive silently, which either
 * failed outright on an account with no private sync path or put the
 * folder somewhere the user was not looking. A folder landing in the
 * wrong drive is harder to notice than a question.
 */
const NewFolderDialog: React.FC = () => {
  const [target, setTarget] = useAtom(newFolderTargetAtom);
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<NewFolderTarget | null>(null);
  const [busy, setBusy] = useState(false);
  // Latched synchronously: `busy` only flips on the next render, so Enter
  // autorepeat could otherwise fire two creates from one dialog.
  const inFlight = useRef(false);

  const open = target !== null;
  // A target that already names a drive came from a view with a folder
  // open, so there is nothing to ask.
  const needsDrive = open && !target?.label;
  const destination = needsDrive ? picked : target;

  useEffect(() => {
    if (!target) return;
    setName("");
    setPicked(null);
    inFlight.current = false;
  }, [target]);

  const close = () => {
    if (busy) return;
    setTarget(null);
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!destination || !polkadotAddress || !trimmed || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await invoke(
        destination.kind === "remote" ? "create_remote_folder" : "create_sync_folder",
        {
          accountId: polkadotAddress,
          label: destination.label ?? null,
          parentPath: destination.parentPath ?? null,
          name: trimmed,
        },
      );
      toast.success(`Created "${trimmed}"`);
      setTarget(null);
      // Wakes the cached lists AND the nested folder listings, which only
      // react to the window event.
      await notifyFilesMutated(queryClient, polkadotAddress);
    } catch (err) {
      // Rust validates the name and owns the sentence.
      toast.error(errorMessage(err));
      inFlight.current = false;
    } finally {
      setBusy(false);
    }
  };

  const canCreate = Boolean(name.trim()) && destination !== null;
  // Where it will land, said plainly under the field. The picker hides
  // itself when the account has only one drive, so without this the
  // dialog would not name the destination at all.
  const whereLabel = target?.parentPath
    ? `${destination?.label ?? ""}/${target.parentPath}`.replace(/^\//, "")
    : destination?.label;

  return (
    <FramedDialog
      open={open}
      onClose={close}
      title="New Folder"
      icon={<FolderPlus className="size-4 text-white" />}
    >
      <div className="flex flex-col gap-5">
        {needsDrive && (
          <SyncFolderSelect
            label="Drive"
            includeRemote
            value={picked?.label ?? null}
            onChange={(label, _path, remote) =>
              setPicked({ kind: remote ? "remote" : "local", label })
            }
          />
        )}

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-folder-name"
            className="text-sm font-medium text-grey-50 dark:text-grey-dark-700"
          >
            Folder name
          </label>
          <Input
            id="new-folder-name"
            autoFocus
            value={name}
            placeholder="Untitled folder"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          {whereLabel && (
            <p className="text-xs font-medium text-grey-50 dark:text-grey-dark-600">
              Created in <span className="font-semibold">{whereLabel}</span>
            </p>
          )}
        </div>

        <div className="flex gap-3">
          <Button
            variant="defaultStable"
            size="auto"
            onClick={close}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="auto"
            loading={busy}
            disabled={!canCreate}
            onClick={() => void create()}
            className="h-[44px] flex-1 rounded-[6px] text-sm font-medium"
          >
            Create
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
};

export default NewFolderDialog;
