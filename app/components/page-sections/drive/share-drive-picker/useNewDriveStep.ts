"use client";

// The "New drive" step of Share a drive: a name, then a drive of that name
// on Hippius, then the Share dialog for it. A step inside the picker rather
// than a dialog of its own, so nothing ever stacks over the picker.
//
// The drive is made with no folder on this computer (`create_cloud_drive`),
// as the console's New drive makes it, so nobody is asked to pick a folder
// to sync just to share something. It lists as "Not synced here", and "Sync
// to this computer" in its menu binds it to a folder later.
//
// Rust checks the name and that no drive already answers to it, and words
// every refusal; this hook only shows what comes back.

import { useCallback, useEffect, useRef, useState } from "react";

import { createCloudDrive } from "@/app/lib/tauri/syncFolders";
import { errorMessage } from "@/app/lib/utils/errorUtils";

/** Shown when a create fails with nothing Rust could word. */
export const CREATE_DRIVE_FAILED = "Hippius couldn't create the drive just now. Try again in a moment.";

export interface NewDriveStep {
  /** The picker is on the New drive step. */
  open: boolean;
  name: string;
  /** Why the create was refused. Shown under the field. */
  error: string | null;
  /** The drive is being made. */
  busy: boolean;
  onOpen: () => void;
  onBack: () => void;
  onNameChange: (_value: string) => void;
  onSubmit: () => void;
}

export function useNewDriveStep({
  accountId,
  onCreated,
}: {
  /** The signed-in account. Without one there is nothing to create for. */
  accountId: string | null | undefined;
  /** The drive exists on Hippius. Gets its name, which is its label. */
  onCreated: (_label: string) => void;
}): NewDriveStep {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Latched synchronously: `busy` only flips on the next render, so Enter
  // autorepeat could otherwise send two creates from one name.
  const inFlight = useRef(false);

  // A create still in flight when the picker goes away must not raise a
  // Share dialog nobody is waiting for.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const onSubmit = useCallback(() => {
    const typed = name.trim();
    if (!typed || !accountId || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const created = await createCloudDrive(accountId, typed);
        if (!live.current) return;
        onCreated(created.label);
      } catch (err) {
        if (!live.current) return;
        setError(errorMessage(err) || CREATE_DRIVE_FAILED);
        setBusy(false);
        inFlight.current = false;
      }
    })();
  }, [name, accountId, onCreated]);

  const onNameChange = useCallback((value: string) => {
    setName(value);
    // A refusal is about the name that was sent; editing it clears the
    // sentence rather than leaving it under a name it no longer describes.
    setError(null);
  }, []);

  const onOpen = useCallback(() => {
    setName("");
    setError(null);
    setOpen(true);
  }, []);

  const onBack = useCallback(() => {
    if (inFlight.current) return;
    setOpen(false);
    setName("");
    setError(null);
  }, []);

  return { open, name, error, busy, onOpen, onBack, onNameChange, onSubmit };
}
